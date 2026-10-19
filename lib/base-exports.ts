// Issue #166: the Base stack owns the VPC, its subnets and each subnet's route
// table/association. The disposable Egress stack must add its default route to
// the Base-owned private route tables instead of creating a second association
// (AWS allows one association per subnet). These are the stable CloudFormation
// export names Base publishes and Egress imports, so the two stacks share the
// ids without Egress re-creating the network — and without a new stage-contract
// parameter (the contract stays 36 definitions / 35 unconditional / 1
// conditional).
//
// The export/import pair is a normal same-account CloudFormation cross-stack
// reference: Base must exist before Egress is created, which is exactly the
// start order (Base is persistent; Egress is recreated). Egress synthesis never
// needs the Base stack object, so `deployScope=egress` still synthesizes one
// artifact-free Egress template.
export const BASE_EXPORTS = Object.freeze({
  vpcId: 'AnyWearBetaBaseVpcId',
  natSubnetId: 'AnyWearBetaBaseNatSubnetId',
  privateRouteTableIds: Object.freeze([
    'AnyWearBetaBasePrivateRouteTable1Id',
    'AnyWearBetaBasePrivateRouteTable2Id',
  ]),
});
