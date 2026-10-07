import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { readIdentityPhase, type IdentityPhase } from './identity-phase';

export interface FoundationStackProps extends cdk.StackProps {
  identityPhase?: IdentityPhase;
}

export class FoundationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: FoundationStackProps) {
    super(scope, id, props);
    const identityPhase = readIdentityPhase(props?.identityPhase);

    // Setup GitHub OIDC Trust Provider
    // This is a singleton resource per AWS Account
    const githubProvider = new iam.OpenIdConnectProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    new cdk.CfnOutput(this, 'GitHubOIDCProviderArn', {
      value: githubProvider.openIdConnectProviderArn,
      description: 'The ARN of the GitHub OIDC Provider',
    });

    // GitHub's immutable OIDC subject remains stable if a repository is
    // renamed, so trust only the owner/repository ID form.
    const serviceSubject = (stage: 'dev' | 'beta' | 'prod') =>
      `repo:git-malu@11473072/AnyWear-Service@1158460323:environment:${stage}`;
    const e2eSubject = (stage: 'dev' | 'beta') =>
      `repo:git-malu@11473072/AnyWear-E2E@1317091305:environment:${stage}`;
    const clientSubject = 'repo:git-malu@11473072/AnyWear-Client@1176104200:environment:beta';

    for (const stage of ['dev', 'beta', 'prod'] as const) {
      const subjects = stage === 'beta' && identityPhase === 'retired' ? [
        // Preserve the role identity with an unmatchable retired subject. No
        // repository is trusted, including the new Infra repository.
        'anywear:retired:beta-github-actions-pipeline-role',
      ] : [
        serviceSubject(stage),
        ...(stage === 'prod' ? [] : [e2eSubject(stage)]),
        ...(stage === 'beta' ? [clientSubject] : []),
      ];
      const role = new iam.Role(this, `${stage}GitHubActionsRole`, {
        roleName: `${stage}-github-actions-pipeline-role`,
        assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': subjects,
          },
        }),
      });
      if (stage === 'beta' && identityPhase === 'retired') continue;
      // Beta billing controls are deployed in the account's billing home
      // region, while the application platform remains in ap-east-1.
      const cdkRoleRegions = stage === 'beta'
        ? [this.region, process.env.BILLING_REGION || 'us-east-1']
        : [this.region];
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: cdkRoleRegions.map((region) => (
          `arn:aws:iam::${this.account}:role/cdk-*-role-${this.account}-${region}`
        )),
      }));
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/anywear/${stage}/*`],
      }));
      const secretResources = [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/anywear/${stage}/cloudfront_origin_header-*`,
      ];
      if (stage === 'dev') {
        secretResources.push(
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/anywear/dev/qweather_api_key-*`,
        );
      }
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: secretResources,
      }));
    }

    if (identityPhase === 'legacy') return;
    const betaSubject = (repository: string, id: number) =>
      `repo:git-malu@11473072/${repository}@${id}:environment:beta`;
    const createRole = (constructId: string, name: string, subject: string) => new iam.Role(this, constructId, {
      roleName: `beta-${name}-role`,
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subject,
        },
      }),
    });
    const infraSubject = betaSubject('AnyWear-Infra', 1409047265);
    const deploy = createRole('BetaInfraDeployRole', 'infra-deploy', infraSubject);
    createRole('BetaInfraRuntimeRole', 'infra-runtime', infraSubject);
    const artifacts = createRole('BetaServiceArtifactRole', 'service-artifact',
      'repo:git-malu@11473072/AnyWear-Service@1158460323:environment:service-artifacts');
    createRole('BetaServiceDataRole', 'service-data', betaSubject('AnyWear-Service', 1158460323));
    createRole('BetaClientPublishRole', 'client-publish', betaSubject('AnyWear-Client', 1176104200));
    createRole('BetaE2EQualificationRole', 'e2e-qualification', betaSubject('AnyWear-E2E', 1317091305));
    // Existing CDK bootstrap roles still own their reviewed deployment policies.
    // Direct callers cannot assume image-publishing or CFN execution roles.
    deploy.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [...new Set([this.region, process.env.BILLING_REGION || 'us-east-1'])]
        .flatMap((region) => ['deploy', 'file-publishing', 'lookup'].map((purpose) => (
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-${purpose}-role-${this.account}-${region}`
        ))),
    }));
    artifacts.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': this.region } },
    }));
    artifacts.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage',
        'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage',
        'ecr:DescribeImages', 'ecr:DescribeImageScanFindings', 'ecr:ListImages', 'ecr:GetLifecyclePolicy'],
      resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/beta-anywear-service`],
    }));
  }
}
