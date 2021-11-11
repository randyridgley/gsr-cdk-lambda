import * as cloud9 from '@aws-cdk/aws-cloud9';
import { Vpc, SubnetType } from '@aws-cdk/aws-ec2';
import { CfnInstanceProfile, ManagedPolicy, Role, ServicePrincipal } from '@aws-cdk/aws-iam';
import * as cdk from '@aws-cdk/core';

export interface ConsoleProps {
  readonly vpc: Vpc;
}

export class KafkaConsole extends cdk.Construct {
  constructor(scope: cdk.Construct, id: string, props: ConsoleProps) {
    super(scope, id);

    const cloud9Ec2AdminRole = new Role(this, 'Cloud9Ec2AdminRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationReadOnlyAccess'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonMSKReadOnlyAccess'),
      ],
    });
    
    new CfnInstanceProfile(this, 'Cloud9Ec2AdminRoleInstanceProfile', {
      roles: [cloud9Ec2AdminRole.roleName],
      path: '/cloud9/'
    });

    const kafkaConsole = new cloud9.CfnEnvironmentEC2(this, 'eksConsole', {
      instanceType: 'm5.large',
      description: 'kafka management console',
      repositories: [
        {
          pathComponent: '/kafka',
          repositoryUrl: 'https://github.com/randyridgley/cloud9-kafka-console'
        }
      ],
      subnetId: props.vpc.selectSubnets( { onePerAz: true, subnetType: SubnetType.PUBLIC }).subnetIds[0],
    });

    new cdk.CfnOutput(this, 'KafkaConsole', { value: kafkaConsole.attrName });
  }
}