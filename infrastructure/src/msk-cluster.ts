import { InstanceClass, InstanceSize, InstanceType, Peer, Port, SecurityGroup, SubnetType, Vpc } from '@aws-cdk/aws-ec2';
import { Key } from '@aws-cdk/aws-kms';
import * as logs from '@aws-cdk/aws-logs';
import { ClientBrokerEncryption, Cluster, ClusterMonitoringLevel, KafkaVersion } from '@aws-cdk/aws-msk';
import * as cdk from '@aws-cdk/core';
import { RemovalPolicy } from '@aws-cdk/core';

export interface MSKProps {
  readonly vpc: Vpc;
  readonly config?: MskConfig;
  readonly removalPolicy: RemovalPolicy;
  readonly clusterName: string;
}

export interface MskConfig {
  readonly arn: string;
  readonly revision: number;
}

export class MSKCluster extends cdk.Construct {
  public readonly mskArn: string
  public readonly bootstrapServers: string
  public readonly cluster: Cluster
  public readonly mskSecurityGroup: SecurityGroup

  constructor(scope: cdk.Construct, id: string, props: MSKProps) {
    super(scope, id);

    const subnetIds: string[] = [];

    props.vpc.publicSubnets.forEach(subnet => {
      subnetIds.push(subnet.subnetId);
    });

    this.mskSecurityGroup = new SecurityGroup(this, 'MskSg', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Security Group for Amazon MSK Brokers',
    });

    this.mskSecurityGroup.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcp(9092),
      'Allow Access to Kafka Brokers for complete VPC',
    );

    this.mskSecurityGroup.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcp(9094),
      'Allow Access to Kafka Brokers TLS for complete VPC',
    );

    this.mskSecurityGroup.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcp(9098),
      'Allow Access to Kafka Brokers SASL/IAM for VPC',
    );

    this.mskSecurityGroup.addIngressRule(
      Peer.ipv4(props.vpc.vpcCidrBlock),
      Port.tcp(2181),
      'Allow Access to Zookeeper for complete VPC',
    );

    this.mskSecurityGroup.addIngressRule(
      this.mskSecurityGroup,
      Port.tcp(9092),
      'Allow Access to Kafka Brokers for complete VPC',
    );

    this.mskSecurityGroup.addIngressRule(
      this.mskSecurityGroup,
      Port.tcp(9094),
      'Allow Access to Kafka Brokers TLS for complete VPC',
    );

    this.mskSecurityGroup.addIngressRule(
      this.mskSecurityGroup,
      Port.tcp(9098),
      'Allow Access to Kafka Brokers SASL/IAM for VPC',
    );

    this.mskSecurityGroup.addIngressRule(
      this.mskSecurityGroup,
      Port.tcp(2181),
      'Allow Access to Zookeeper for complete VPC',
    );

    const encryptionKey = new Key(this, 'mskKey', {
      alias: 'mskEncryptionKey',
      description: 'Amazon MSK Encryption Key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, 'LogGroup', { removalPolicy: cdk.RemovalPolicy.RETAIN });

    this.cluster = new Cluster(this, 'mskCluster', {
      clusterName: props.clusterName,
      kafkaVersion: KafkaVersion.V2_8_0,
      numberOfBrokerNodes: props.vpc.availabilityZones.length,
      removalPolicy: props.removalPolicy,
      encryptionInTransit: {
        enableInCluster: true,
        clientBroker: ClientBrokerEncryption.TLS_PLAINTEXT,
      },
      ebsStorageInfo: {
        encryptionKey: encryptionKey,
        volumeSize: 128,
      },
      vpc: props.vpc,
      clientAuthentication: {
        saslProps: {
          iam: false,
          scram: false,
        },
      },
      monitoring: {
        clusterMonitoringLevel: ClusterMonitoringLevel.PER_TOPIC_PER_BROKER,
        enablePrometheusJmxExporter: true,
        enablePrometheusNodeExporter: true,
      },
      instanceType: InstanceType.of(InstanceClass.M5, InstanceSize.LARGE),
      logging: {
        cloudwatchLogGroup: logGroup,
      },
      vpcSubnets: props.vpc.selectSubnets({
        subnetType: SubnetType.PRIVATE_WITH_NAT,
      }),
      securityGroups: [
        this.mskSecurityGroup,
      ],
    });

    this.mskArn = this.cluster.clusterArn;

    new cdk.CfnOutput(this, 'KafkaResponse', { value: this.cluster.bootstrapBrokersTls });
    this.bootstrapServers = this.cluster.bootstrapBrokersTls;
  }
}
