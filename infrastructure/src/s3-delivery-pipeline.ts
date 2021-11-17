import { Bucket } from '@aws-cdk/aws-s3';
import { CfnDeliveryStream } from '@aws-cdk/aws-kinesisfirehose'
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { CfnTable, Database} from '@aws-cdk/aws-glue';

import { Aws, Construct, CfnOutput, RemovalPolicy } from '@aws-cdk/core';
import { RetentionDays, LogGroup, LogStream } from '@aws-cdk/aws-logs';

export interface DeliveryPipelineProps {
  bucket: Bucket,  
  database: Database,
  baseTableName: string,
  processedColumns: Array<CfnTable.ColumnProperty>,
  processedPartitions?: Array<CfnTable.ColumnProperty>,
  rawColumns: Array<CfnTable.ColumnProperty>,
  rawPartitions?: Array<CfnTable.ColumnProperty>,
  timestampColumn: string,
}

export class S3DeliveryPipeline extends Construct {
  public readonly deliveryStream: CfnDeliveryStream;

  constructor(scope: Construct, id: string, props: DeliveryPipelineProps) {
    super(scope, id);

    const processedCols = props.processedColumns.map(col => col.name).join(',').toString();
    const processedPartionKeys = props.processedPartitions ? props.processedPartitions : []

    const table = new CfnTable(this, 'p_' + props.baseTableName, {
      databaseName: props.database.databaseName,
      catalogId: Aws.ACCOUNT_ID,
      tableInput: {
        description: `processed ${props.baseTableName}`,
        name: `p_${props.baseTableName}`,
        parameters: {
          has_encrypted_data: false,
          classification: 'parquet', 
          typeOfData: 'file'
        },
        partitionKeys: processedPartionKeys,
        storageDescriptor: { 
          columns: props.processedColumns,
          compressed: false,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          location: `s3://${props.bucket.bucketName}/${props.baseTableName}/processed/`,
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            parameters: {
              paths: processedCols
            },
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
          },
          storedAsSubDirectories: false,          
        },
        tableType: 'EXTERNAL_TABLE'
      }      
    });
    new CfnOutput(this, 'ProcessedTable', { value: table.ref });

    // const rawCols = props.rawColumns.filter(col => col.name.toString()).join(',') // coming back as [Object object]
    const rawCols = props.rawColumns.map(col => col.name).join(',').toString();
    const rawPartionKeys = props.rawPartitions ? props.rawPartitions : []
    
    const rawTable = new CfnTable(this, 'o_' + props.baseTableName, {
      databaseName: props.database.databaseName,
      catalogId: Aws.ACCOUNT_ID,
      tableInput: {
        description: `raw ${props.baseTableName}`,
        name: `r_${props.baseTableName}`,
        parameters: {
          has_encrypted_data: false,
          classification: 'json', 
          typeOfData: 'file'
        },
        partitionKeys: rawPartionKeys,
        storageDescriptor: { 
          columns: props.rawColumns,
          compressed: false,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          location: `s3://${props.bucket.bucketName}/${props.baseTableName}/raw/`,
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            parameters: {
              paths: rawCols
            },
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe'
          },
          storedAsSubDirectories: false
        },
        tableType: 'EXTERNAL_TABLE'
      } 
    });
    new CfnOutput(this, 'RawTable', { value: rawTable.ref });

    const firehoseLogGroup = new LogGroup(this, 'FirehoseLogGroup', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const firehoseLogStream = new LogStream(this, 'FirehoseLogStream', {
      logGroup: firehoseLogGroup,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const firehoseLogStreamArn = `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:${firehoseLogGroup.logGroupName}:log-stream:${firehoseLogStream.logStreamName}`;

    const firehoseRole = new Role(this, 'FirehoseRole', {
      assumedBy: new ServicePrincipal('firehose.amazonaws.com'),
      inlinePolicies: {
        'GluePermissions' : new PolicyDocument({
          statements : [
              new PolicyStatement({
                  actions : [
                    'glue:GetTableVersions'
                  ],
                  resources : ['*']
              })
          ]
        }),
        'CloudWatchPermissions': new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['cloudwatch:PutMetricData'],
              resources: ['*']
            })
          ]
        }),
        'LogsPermissions': new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['logs:DescribeLogStreams', 'logs:DescribeLogGroups'],
              resources: [
                firehoseLogGroup.logGroupArn,
                `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:*`
              ]        
            })
          ]
        }),
        'LogsPutPermissions': new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['logs:PutLogEvents'],
              resources: [firehoseLogStreamArn]
            })
          ]
        }),
        'S3Permissions': new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions : [
                's3:AbortMultipartUpload',
                's3:GetBucketLocation',
                's3:GetObject',
                's3:ListBucket',
                's3:ListBucketMultipartUploads',
                's3:PutObject',
              ],
              resources : [
                  props.bucket.bucketArn,
                  props.bucket.bucketArn + '/*'
              ]
            })
          ]
        })
      }
    });

    this.deliveryStream = new CfnDeliveryStream(this, 'DataDeliveryStream', {
      deliveryStreamType: 'DirectPut',
      extendedS3DestinationConfiguration: {
        bucketArn: props.bucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 128
        },
        compressionFormat: 'UNCOMPRESSED',
        cloudWatchLoggingOptions: {
          enabled: true,
          logGroupName: firehoseLogGroup.logGroupName,
          logStreamName: firehoseLogStream.logStreamName
        },
        prefix: `${props.baseTableName}/processed/year=!{partitionKeyFromQuery:year}/month=!{partitionKeyFromQuery:month}/day=!{partitionKeyFromQuery:day}/`,
        errorOutputPrefix: 'error/',
        s3BackupMode: 'Enabled',
        s3BackupConfiguration: {
          roleArn: firehoseRole.roleArn,
          bucketArn: props.bucket.bucketArn,
          errorOutputPrefix: `${props.baseTableName}/failed/!{firehose:error-output-type}/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/`,
          prefix: `${props.baseTableName}/raw/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/`, // this is lame cause s3 backup doesn't support dynamic partitioning
          bufferingHints: {
            sizeInMBs: 128,
            intervalInSeconds: 60
          },
          compressionFormat: 'UNCOMPRESSED',
          encryptionConfiguration: {
            noEncryptionConfig: 'NoEncryption'
          },
          cloudWatchLoggingOptions: {
            enabled: true,
            logGroupName: firehoseLogGroup.logGroupName,
            logStreamName: firehoseLogStream.logStreamName
          }
        },
        dataFormatConversionConfiguration: {
          schemaConfiguration: {
            roleArn: firehoseRole.roleArn,
            catalogId: Aws.ACCOUNT_ID,
            databaseName: props.database.databaseName,
            tableName: `p_${props.baseTableName}`,
            region: Aws.REGION,
            versionId: 'LATEST'
          },
          inputFormatConfiguration: {
            deserializer: {
              openXJsonSerDe: {}
            }
          },
          outputFormatConfiguration: {
            serializer: {
              parquetSerDe: {}
            }
          },
          enabled: true
        },
        dynamicPartitioningConfiguration: {
          enabled: true,
          retryOptions: {
            durationInSeconds: 10,
          },
        },
        processingConfiguration: {
          enabled: true,
          processors: [
            {
              type: 'AppendDelimiterToRecord',
              parameters: [],
            },
            {
              type: 'MetadataExtraction',
              parameters: [
                {
                  parameterName: 'MetadataExtractionQuery',
                  parameterValue: `{year:.${props.timestampColumn} | strftime(\"%Y\"),month:.${props.timestampColumn} | strftime(\"%m\"),day:.${props.timestampColumn} | strftime(\"%d\")}`,
                },
                {
                  parameterName: 'JsonParsingEngine',
                  parameterValue: 'JQ-1.6',
                },
              ],
            },
          ],
        },
      }
    });
    new CfnOutput(this, 'CloudwatchLogsInsights', { value: `https://console.aws.amazon.com/cloudwatch/home#logs-insights:queryDetail=~(end~0~source~'${firehoseLogGroup.logGroupName}~start~-3600~timeType~'RELATIVE~unit~'seconds)` });
  }
}