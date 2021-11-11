import * as ec2 from '@aws-cdk/aws-ec2';
import * as cdk from '@aws-cdk/core';

export class VpcNetwork extends cdk.Construct {
  vpc: ec2.Vpc

  constructor(scope: cdk.Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'VpcNetwork', { maxAzs: 2 });

    new cdk.CfnOutput(this, 'VpcNetworkId', {
      exportName: 'VpcNetworkId',
      value: this.vpc.vpcId,
    });

    // S3 Gateway endpoint to be used by MSK Connect
    new ec2.GatewayVpcEndpoint(this, 's3-vpce', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      vpc: this.vpc,
    });

    new ec2.InterfaceVpcEndpoint(this, 'lambda-vpce', {
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      vpc: this.vpc,
    });

    new ec2.InterfaceVpcEndpoint(this, 'sts-vpce', {
      service: ec2.InterfaceVpcEndpointAwsService.STS,
      vpc: this.vpc,
    });

    new ec2.InterfaceVpcEndpoint(this, 'secreatesmanager-vpce', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      vpc: this.vpc,
    });
  }
}