import { SecurityGroup, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { CfnRegistry } from '@aws-cdk/aws-glue';
import { PolicyStatement, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import { DeliveryStream } from '@aws-cdk/aws-kinesisfirehose';
import { S3Bucket } from '@aws-cdk/aws-kinesisfirehose-destinations';
import { Code, Runtime, Function, StartingPosition } from '@aws-cdk/aws-lambda';
import { ManagedKafkaEventSource } from '@aws-cdk/aws-lambda-event-sources';
import { LogGroup, RetentionDays } from '@aws-cdk/aws-logs';
import { Bucket } from '@aws-cdk/aws-s3';
import { App, CfnOutput, Construct, Duration, RemovalPolicy, Size, Stack, StackProps } from '@aws-cdk/core';
import { KafkaConsole } from './kafka-console';
import { MSKCluster } from './msk-cluster';
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
  readonly deliveryStream: DeliveryStream;

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

    const firehoseRole = new Role(this, 'kinesis-role', {
      assumedBy: new ServicePrincipal('firehose.amazonaws.com'),
    });

    const firehoseLogGroup = new LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: '/aws/firehose/gsr',
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_DAY,
    })

    const s3Destination = new S3Bucket(this.bucket, {
      bufferingInterval: Duration.seconds(60),
      bufferingSize: Size.mebibytes(64),
      dataOutputPrefix: 'output/',
      logGroup: firehoseLogGroup,
    });

    this.deliveryStream = new DeliveryStream(this, 'DeliveryStream', {
      role: firehoseRole,
      destinations: [s3Destination]
    });

    this.bucket.grantWrite(firehoseRole);
    firehoseLogGroup.grantWrite(firehoseRole);    
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
  readonly deliveryStream: DeliveryStream;
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
        DELIVERY_STREAM_NAME: props.deliveryStream.deliveryStreamName,
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
    props.deliveryStream.grantPutRecords(consumerFunction);
    
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
  mskArn: 'arn:aws:kafka:us-east-1:649037252677:cluster/GSRKafkaCluster/9d52f751-b878-4412-921b-2f9b72302c7e-4', // coreStack.mskArn,
  securityGroup: coreStack.securityGroup,
  registryName: coreStack.registryName,
  bucket: coreStack.bucket,
  deliveryStream: coreStack.deliveryStream,  
});

app.synth();