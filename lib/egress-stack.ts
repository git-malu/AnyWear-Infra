import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { BASE_EXPORTS } from './base-exports';

// Issue #166: the Egress stack is the disposable network edge of Beta. It holds
// only the paid, recreatable egress resources, so stopping Beta is deleting this
// stack and the Infra-owned Runtime stack while the Base stack (VPC, subnets,
// route tables/associations, Aurora, S3, Cognito, ECR, SQS, SSM, CloudFront)
// stays untouched.
//
// Route tables and associations are Base-owned: AWS allows one association per
// subnet and Base already creates it. Egress imports the Base VPC id, the NAT
// placement subnet and each Base private route-table id through the explicit
// CloudFormation exports in `base-exports.ts`, then adds only the 0.0.0.0/0
// routes into those tables. Deleting Egress removes the routes (and the NAT,
// EIP and S3 gateway endpoint), returning the same Private subnets to the
// isolated state without a Base update. There is no second association and no
// new stage-contract parameter.
//
// The imports are ordinary same-account CloudFormation exports; Egress synthesis
// needs no Base stack object and no Service artifact directory.
export const EGRESS_STACK_NAME = 'AnyWearEgressStack-beta';

export interface EgressStackProps extends cdk.StackProps {
  // Drill precondition: reuse an existing retained EIP allocation instead of
  // creating (and later replacing) the stack-owned EIP on a start.
  natEipAllocationId?: string;
}

const NAT_EIP_ALLOCATION = /^eipalloc-[0-9a-f]+$/;

export class EgressStack extends cdk.Stack {
  readonly natEip?: ec2.CfnEIP;
  readonly natGateway: ec2.CfnNatGateway;
  readonly defaultRoutes: ec2.CfnRoute[];
  readonly s3GatewayEndpoint: ec2.CfnVPCEndpoint;

  constructor(scope: Construct, id: string, props: EgressStackProps = {}) {
    super(scope, id, props);

    const importBase = (exportName: string): string => cdk.Fn.importValue(exportName);
    const vpcId = importBase(BASE_EXPORTS.vpcId);
    if (props.natEipAllocationId !== undefined && !NAT_EIP_ALLOCATION.test(props.natEipAllocationId)) {
      throw new Error('natEipAllocationId must be an Elastic IP allocation id (eipalloc-...)');
    }

    // Issue #166 drill precondition: with an explicit retained allocation the
    // stack creates no EIP, so a stop/start keeps the provider's source address.
    // Without one it creates a fresh EIP (retained across stack deletion), which
    // is the fallback when the pinned allocation is unavailable. A revert of the
    // earlier new-EIP experiment still replaces the EIP and allocates another one.
    if (props.natEipAllocationId) {
      this.natGateway = new ec2.CfnNatGateway(this, 'NatGatewayNext', {
        allocationId: props.natEipAllocationId,
        subnetId: importBase(BASE_EXPORTS.natSubnetId),
        connectivityType: 'public',
        tags: [{ key: 'Name', value: 'beta-anywear-egress-nat' }],
      });
    } else {
      this.natEip = new ec2.CfnEIP(this, 'NatEipNext', {
        domain: 'vpc',
        tags: [{ key: 'Name', value: 'beta-anywear-egress-nat' }],
      });
      this.natEip.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      this.natGateway = new ec2.CfnNatGateway(this, 'NatGatewayNext', {
        allocationId: this.natEip.attrAllocationId,
        subnetId: importBase(BASE_EXPORTS.natSubnetId),
        connectivityType: 'public',
        tags: [{ key: 'Name', value: 'beta-anywear-egress-nat' }],
      });
    }

    // One default route per Base-owned private route table. No route table, no
    // subnet route-table association and no subnet is created here.
    this.defaultRoutes = BASE_EXPORTS.privateRouteTableIds.map((exportName, index) => new ec2.CfnRoute(
      this, `PrivateDefaultRoute${index + 1}`, {
        routeTableId: importBase(exportName),
        destinationCidrBlock: '0.0.0.0/0',
        natGatewayId: this.natGateway.ref,
      },
    ));

    // The S3 gateway endpoint moves here with the egress routes: while the
    // environment is stopped there is no gateway endpoint, so S3 access from the
    // Private tier requires this stack. It attaches to the Base-owned route
    // tables, exactly like the default routes.
    this.s3GatewayEndpoint = new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      serviceName: `com.amazonaws.${this.region}.s3`,
      vpcId,
      routeTableIds: BASE_EXPORTS.privateRouteTableIds.map(importBase),
    });

    new cdk.CfnOutput(this, 'EgressNatGatewayId', { value: this.natGateway.ref });
    new cdk.CfnOutput(this, 'EgressNatEipAllocationId', {
      value: props.natEipAllocationId ?? this.natEip!.attrAllocationId,
    });
    new cdk.CfnOutput(this, 'EgressPrivateRouteTableIds', {
      value: cdk.Fn.join(',', BASE_EXPORTS.privateRouteTableIds.map(importBase)),
    });
  }
}
