import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface BillingStackProps extends cdk.StackProps {
  stage: 'beta';
}

/**
 * Account-level billing controls live in the AWS billing home region. Billing
 * CloudFormation billing resource types such as AWS::Budgets::Budget are not
 * available in every application region (including ap-east-1), so they must
 * not be part of the regional platform stack.
 */
export class BillingStack extends cdk.Stack {
  readonly billingTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: BillingStackProps) {
    super(scope, id, props);

    if (props.stage !== 'beta') {
      throw new Error(`BillingStack only supports the beta stage, received ${props.stage}`);
    }

    this.billingTopic = new sns.Topic(this, 'BillingTopic', {
      topicName: 'beta-anywear-billing',
      displayName: 'AnyWear Beta billing alerts',
    });
    for (const email of ['windy005@126.com', 'luma26c@gmail.com'] as const) {
      this.billingTopic.addSubscription(new snsSubscriptions.EmailSubscription(email));
    }
    this.billingTopic.grantPublish(new iam.ServicePrincipal('budgets.amazonaws.com'));
    this.billingTopic.grantPublish(new iam.ServicePrincipal('costalerts.amazonaws.com'));

    const notifications: budgets.CfnBudget.NotificationWithSubscribersProperty[] = [50, 80, 100].map((threshold) => ({
      notification: {
        notificationType: 'ACTUAL',
        threshold,
        thresholdType: 'PERCENTAGE',
        comparisonOperator: 'GREATER_THAN',
      },
      subscribers: [{ subscriptionType: 'SNS', address: this.billingTopic.topicArn }],
    }));
    notifications.push({
      notification: {
        notificationType: 'FORECASTED',
        threshold: 100,
        thresholdType: 'PERCENTAGE',
        comparisonOperator: 'GREATER_THAN',
      },
      subscribers: [{ subscriptionType: 'SNS', address: this.billingTopic.topicArn }],
    });
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'beta-anywear-monthly-300-usd',
        budgetLimit: { amount: 300, unit: 'USD' },
        timeUnit: 'MONTHLY',
        budgetType: 'COST',
      },
      notificationsWithSubscribers: notifications,
    });

    const anomalyMonitor = new ce.CfnAnomalyMonitor(this, 'CostAnomalyMonitor', {
      monitorName: 'beta-anywear-cost-anomaly',
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });
    new ce.CfnAnomalySubscription(this, 'CostAnomalySubscription', {
      subscriptionName: 'beta-anywear-cost-anomaly-subscription',
      frequency: 'IMMEDIATE',
      monitorArnList: [anomalyMonitor.ref],
      threshold: 10,
      subscribers: [{ type: 'SNS', address: this.billingTopic.topicArn }],
    });

    new cdk.CfnOutput(this, 'BillingTopicArn', { value: this.billingTopic.topicArn });
  }
}
