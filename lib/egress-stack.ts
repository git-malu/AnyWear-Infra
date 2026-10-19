import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

// Issue #166: the Egress stack is the disposable network edge of Beta. It holds
// only the paid, recreatable egress resources, so stopping Beta is deleting this
// stack and the Service-owned Runtime stack while the Base stack (VPC, subnets,
// Aurora, S3, Cognito, ECR, SQS, SSM, CloudFront) stays untouched.
//
// The inputs are the Base stack's published stage-contract parameters, read as
// `AWS::SSM::Parameter::Value<...>` parameters at deploy time. That keeps the
// two stacks decoupled: the Base stack keeps the physical subnets and VPC, and
// this stack attaches a NAT route to the Base Private tier. Deleting it removes
// the route tables and the NAT, so the same Private subnets become isolated
// again without any Base update. The Base Private tier is created with exactly
// two subnets (`maxAzs: 2`), so the two route tables below are per AZ.
export const EGRESS_STACK_NAME = 'AnyWearEgressStack-beta';
export const EGRESS_VPC_ID_PARAMETER = '/anywear/beta/vpc_id';
export const EGRESS_PUBLIC_SUBNET_IDS_PARAMETER = '/anywear/beta/public_subnet_ids';
export const EGRESS_PRIVATE_SUBNET_IDS_PARAMETER = '/anywear/beta/private_subnet_ids';

export interface EgressStackProps extends cdk.StackProps {
  /** Absolute SSM parameter names; overridable only for a stage simulation. */
  vpcIdParameterName?: string;
  publicSubnetIdsParameterName?: string;
  privateSubnetIdsParameterName?: string;
}

export class EgressStack extends cdk.Stack {
  readonly natEip: ec2.CfnEIP;
  readonly natGateway: ec2.CfnNatGateway;
  readonly privateRouteTables: ec2.CfnRouteTable[];
  readonly s3GatewayEndpoint: ec2.CfnVPCEndpoint;

  constructor(scope: Construct, id: string, props: EgressStackProps = {}) {
    super(scope, id, props);

    // The published values are CloudFormation parameters, not CDK lookups: a
    // deploy reads them with the CloudFormation execution role and no synthesis
    // ever calls SSM.
    const vpcId = new cdk.CfnParameter(this, 'BaseVpcId', {
      type: 'AWS::SSM::Parameter::Value<String>',
      default: props.vpcIdParameterName ?? EGRESS_VPC_ID_PARAMETER,
      description: 'Base VPC id published by AnyWearPlatformStack-beta',
    });
    const publicSubnetIds = new cdk.CfnParameter(this, 'BasePublicSubnetIds', {
      type: 'AWS::SSM::Parameter::Value<List<String>>',
      default: props.publicSubnetIdsParameterName ?? EGRESS_PUBLIC_SUBNET_IDS_PARAMETER,
      description: 'Base public subnet ids; the NAT gateway lives in the first one',
    });
    const privateSubnetIds = new cdk.CfnParameter(this, 'BasePrivateSubnetIds', {
      type: 'AWS::SSM::Parameter::Value<List<String>>',
      default: props.privateSubnetIdsParameterName ?? EGRESS_PRIVATE_SUBNET_IDS_PARAMETER,
      description: 'Base Private-tier subnet ids; one NAT route table is attached to each',
    });

    this.natEip = new ec2.CfnEIP(this, 'NatEip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: 'beta-anywear-egress-nat' }],
    });
    this.natGateway = new ec2.CfnNatGateway(this, 'NatGateway', {
      allocationId: this.natEip.attrAllocationId,
      subnetId: cdk.Fn.select(0, publicSubnetIds.valueAsList),
      connectivityType: 'public',
      tags: [{ key: 'Name', value: 'beta-anywear-egress-nat' }],
    });

    // One route table and association per Base Private subnet. The Base stack
    // creates two (maxAzs: 2); a changed AZ count is a reviewed change to both
    // stacks, and the second select would fail the deploy loudly rather than
    // silently leaving a subnet without egress.
    const createPrivateRoute = (index: number): ec2.CfnRouteTable => {
      const routeTable = new ec2.CfnRouteTable(this, `PrivateRouteTable${index + 1}`, {
        vpcId: vpcId.valueAsString,
        tags: [{ key: 'Name', value: `beta-anywear-egress-private-${index + 1}` }],
      });
      new ec2.CfnRoute(this, `PrivateDefaultRoute${index + 1}`, {
        routeTableId: routeTable.ref,
        destinationCidrBlock: '0.0.0.0/0',
        natGatewayId: this.natGateway.ref,
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `PrivateSubnetAssociation${index + 1}`, {
        subnetId: cdk.Fn.select(index, privateSubnetIds.valueAsList),
        routeTableId: routeTable.ref,
      });
      return routeTable;
    };
    this.privateRouteTables = [createPrivateRoute(0), createPrivateRoute(1)];

    // The S3 gateway endpoint moves here with the egress route tables: while the
    // environment is stopped there is no gateway endpoint, so S3 access from the
    // Private tier requires this stack. The Isolated tier never gets it.
    this.s3GatewayEndpoint = new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      serviceName: `com.amazonaws.${this.region}.s3`,
      vpcId: vpcId.valueAsString,
      routeTableIds: this.privateRouteTables.map((routeTable) => routeTable.ref),
    });

    new cdk.CfnOutput(this, 'EgressNatGatewayId', { value: this.natGateway.ref });
    new cdk.CfnOutput(this, 'EgressNatEipAllocationId', { value: this.natEip.attrAllocationId });
    new cdk.CfnOutput(this, 'EgressPrivateRouteTableIds', {
      value: cdk.Fn.join(',', this.privateRouteTables.map((routeTable) => routeTable.ref)),
    });
  }
}
