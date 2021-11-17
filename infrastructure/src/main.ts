import { SecurityGroup, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { CfnCrawler, CfnRegistry, Database } from '@aws-cdk/aws-glue';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { CfnDeliveryStream } from '@aws-cdk/aws-kinesisfirehose';
import { Code, Runtime, Function, StartingPosition } from '@aws-cdk/aws-lambda';
import { ManagedKafkaEventSource } from '@aws-cdk/aws-lambda-event-sources';
import { Bucket } from '@aws-cdk/aws-s3';
import { App, CfnOutput, Construct, Duration, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';
import { KafkaConsole } from './kafka-console';
import { MSKCluster } from './msk-cluster';
import { S3DeliveryPipeline } from './s3-delivery-pipeline';
import { VpcNetwork } from './vpc-network';

export interface CoreStackProps extends StackProps {
  readonly registryName: string
}

export class CoreMessagingStack extends Stack {
  readonly vpc: Vpc;
  readonly mskArn: string;
  readonly securityGroup: SecurityGroup;
  readonly registryName: string;
  readonly bucket: Bucket;
  readonly deliveryStream: CfnDeliveryStream;

  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id, props);
    const vpcNetwork = new VpcNetwork(this, 'VpcNetwork');
    this.vpc = vpcNetwork.vpc;

    const cluster = new MSKCluster(this, 'MskCluster', {
      vpc: vpcNetwork.vpc,
      removalPolicy: RemovalPolicy.DESTROY,
      clusterName: 'GSRKafkaCluster'
    });
    this.mskArn = cluster.mskArn
    this.securityGroup = cluster.mskSecurityGroup
    new CfnOutput(this, 'MSKClusterArn', { value: cluster.mskArn });

    const registry = new CfnRegistry(this, 'GSR', {
      name: props.registryName,
      description: props.description,
    });
    this.registryName = registry.name

    this.bucket = new Bucket(this, 'Bucket')

    const database = new Database(this, 'ClickStreamDatabase', {
      databaseName: 'clickstreamdb'
    });

    const delivery = new S3DeliveryPipeline(this, 's3-delivery-pipeline', {
        bucket: this.bucket,  
        database: database,
        baseTableName: 'clickstream',
        timestampColumn: 'eventtimestamp',
        rawColumns: [
          { name: "ip", type: "string" },
          { name: "eventtimestamp", type: "int" },
          { name: "devicetype", type: "string" },
          { name: "event_type", type: "string" },
          { name: "product_type", type: "string" },
          { name: "userid", type: "int" },
          { name: "globalseq", type: "int" },
          { name: "prevglobalseq", type: "int" }
        ],
        rawPartitions: [
          { name: "year", type: "string" },
          { name: "month", type: "string" },
          { name: "day", type: "string" },
        ],
        processedColumns: [
          { name: "ip", type: "string" },
          { name: "eventtimestamp", type: "int" },
          { name: "devicetype", type: "string" },
          { name: "event_type", type: "string" },
          { name: "product_type", type: "string" },
          { name: "userid", type: "int" },
          { name: "globalseq", type: "int" },
          { name: "prevglobalseq", type: "int" }
        ],
        processedPartitions: [
          { name: "year", type: "string" },
          { name: "month", type: "string" },
          { name: "day", type: "string" },
        ],
    });
    this.deliveryStream = delivery.deliveryStream;
    
    const crawlerRole = new Role(this, 'GluePartitionCrawlerRole', {
      assumedBy: new ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ]
    });
    this.bucket.grantRead(crawlerRole);

    new CfnCrawler(this, 'PartitionUpdateCralwer', {
      role:  crawlerRole.roleName,
      targets: {
        catalogTargets: [
          {
            databaseName: database.databaseName,
            tables: [
              'p_clickstream'
            ]
          },
          {
            databaseName: database.databaseName,
            tables: [
              'r_clickstream'
            ]
          }          
        ]
      },
      configuration: '{"Version":1.0,"CrawlerOutput":{"Partitions":{"AddOrUpdateBehavior":"InheritFromTable"}},"Grouping":{"TableGroupingPolicy":"CombineCompatibleSchemas"}}',
      databaseName: database.databaseName,
      name: 'ClickstreamUpdatePartitionCrawler',
      description: 'Crawler to update partitions of clickstream tables every 5 minutes',
      recrawlPolicy: {
        recrawlBehavior: 'CRAWL_EVERYTHING'
      },
      schedule: {
        scheduleExpression: 'cron(0/5 * * * ? *)',
      },
      schemaChangePolicy: {
        deleteBehavior: 'LOG',
        updateBehavior: 'UPDATE_IN_DATABASE'
      },      
    })
  }
}

export interface GlueSchemaRegistryStackProps extends StackProps {
  readonly name: string;
  readonly description: string;
  readonly vpc: Vpc;
  readonly mskArn: string;
  readonly securityGroup: SecurityGroup;
  readonly registryName: string;
  readonly bucket: Bucket;
  readonly deliveryStream: CfnDeliveryStream;
}

export class GlueSchemaRegistryConsumerStack extends Stack {
  constructor(scope: Construct, id: string, props: GlueSchemaRegistryStackProps) {
    super(scope, id, props);
    
    const glueRegistryPolicy = new PolicyStatement({
      actions: [
        "glue:GetSchemaVersion"
      ],
      resources: ['*']
    });    

    // add glue:GetSchemaVersion to role needed for lambda
    const consumerFunction = new Function(this, 'S3Lambda', {
      runtime: Runtime.JAVA_8,
      memorySize: 512,
      handler: 'org.burrito.consumer.HandlerMSK',
      code: Code.fromAsset('scripts/gsr-resources-1.0-SNAPSHOT.jar'),
      timeout: Duration.seconds(300),
      environment: {
        DEFAULT_SCHEMA_REGISTRY_NAME: props.registryName,
        DELIVERY_STREAM_NAME: props.deliveryStream.ref,
        RETRIES: '3',
        CSR: 'false',
        SECONDARY_DESERIALIZER: 'false'
      },
      securityGroups: [props.securityGroup],
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_NAT
      }
    })
    consumerFunction.addToRolePolicy(glueRegistryPolicy);
    props.bucket.grantRead(consumerFunction);
    // props.deliveryStream.grantPutRecords(consumerFunction);
    const firehosePolicy = new PolicyStatement({
      actions: [
        "firehose:PutRecord",
        "firehose:PutRecordBatch",
      ],
      resources: ['*']
    }); 
    consumerFunction.addToRolePolicy(firehosePolicy);

    consumerFunction.addEventSource(new ManagedKafkaEventSource({
      clusterArn: props.mskArn, // broken until naming gets fixed https://github.com/aws/aws-cdk/issues/15700
      topic: 'ExampleTopic',
      startingPosition: StartingPosition.TRIM_HORIZON,
      enabled: false, //if topic doesn't exist this fails if true
    }));
  }
}

export interface GlueSchemaRegistryProducerStackProps extends StackProps {
  readonly vpc: Vpc;
}

export class GlueSchemaRegistryProducerStack extends Stack {
  constructor(scope: Construct, id: string, props: GlueSchemaRegistryProducerStackProps) {
    super(scope, id, props);

    new KafkaConsole(this, 'KafkaConsole', {
      vpc: props.vpc,
    });
  }
}

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

const coreStack = new CoreMessagingStack(app, 'CoreStack', {
  env: devEnv,
  registryName: 'test-registry',
})

new GlueSchemaRegistryProducerStack(app, 'GSRProducerStack', {
  env: devEnv,
  vpc: coreStack.vpc,
});

new GlueSchemaRegistryConsumerStack(app, 'GSRConsumerStack', {
  env: devEnv,
  name: 'test-registry',
  description: 'default schema registry for kafka topics',
  vpc: coreStack.vpc,
  mskArn: 'arn:aws:kafka:us-east-1:649037252677:cluster/GSRKafkaCluster/8e939997-8cab-4b83-9a77-15b222490f97-21', // coreStack.mskArn,
  securityGroup: coreStack.securityGroup,
  registryName: coreStack.registryName,
  bucket: coreStack.bucket,
  deliveryStream: coreStack.deliveryStream,  
});

app.synth();