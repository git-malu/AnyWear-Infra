# Database recovery drill

The database is the only irreversible asset in the system: down-migrations are
prohibited, so a lost cluster cannot be rebuilt from application source. This
runbook states the recovery targets and defines the drill that proves a restore
is possible. It records targets, not measurements; no drill result is recorded
here.

## Targets

| Stage | PITR retention | Preferred backup window (UTC) | Cluster deletion protection | Cluster removal policy |
| --- | --- | --- | --- | --- |
| Beta | 7 days | `16:00-16:30` | enabled | `DESTROY` (an authorized teardown must unlock first) |
| Production | 35 days | `16:00-16:30` | enabled | `RETAIN` |

These are targets, not observations. Production has no cluster yet, so its row
states what its source must deliver. The values come from the shared recovery
targets used by the source synthesis and the deployment precondition.

Aurora offers no instance-level deletion protection: `AWS::RDS::DBInstance`
`DeletionProtection` does not apply to Aurora DB instances, and instances in a
DB cluster can be deleted even while the cluster is protected. The cluster's
`DeletionProtection` is the lever. In Production the writer instance's
`DeletionPolicy` is `Retain` because it follows the cluster's `RETAIN` removal
policy.

## Unlocking a protected cluster for an authorized teardown

Deletion protection blocks the delete or destroy that ends the retention window.
Unlock it only as the reviewed teardown step, and never as part of a drill:

1. Confirm the teardown is authorized and that ending the retention window
   (7 days for Beta, 35 days for Production) is intended.
2. Remove cluster protection:
   ```sh
   aws rds modify-db-cluster --db-cluster-identifier <beta-cluster-id> --no-deletion-protection
   ```
   Use `<production-cluster-id>` for Production.
3. Wait for the cluster to become `available` and confirm `DeletionProtection`
   is disabled before issuing any delete or destroy.

The unlock is itself the reviewed operation step; it is not part of the drill.

## Drill procedure

A drill restores a backup or point-in-time recovery point to a temporary cluster,
records the result, and then removes the temporary cluster. It does not modify
the live cluster.

1. Choose the recovery point for the drill (a point in time or a snapshot) and
   record it before restoring.
2. Restore to a temporary cluster, with protection enabled while it exists.

   From a point in time:
   ```sh
   aws rds restore-db-cluster-to-point-in-time \
     --db-cluster-identifier <drill-cluster-id> \
     --source-db-cluster-identifier <beta-cluster-id> \
     --restore-to-time <recovery-point> \
     --deletion-protection
   ```
   From a snapshot:
   ```sh
   aws rds restore-db-cluster-from-snapshot \
     --db-cluster-identifier <drill-cluster-id> \
     --snapshot-identifier <snapshot-id> \
     --engine aurora-postgresql \
     --deletion-protection
   ```
   Use `--use-latest-restorable-time` instead of `--restore-to-time` to select
   the latest restorable time.
3. Add one temporary instance so the restored database can be queried:
   ```sh
   aws rds create-db-instance \
     --db-instance-identifier <drill-instance-id> \
     --db-cluster-identifier <drill-cluster-id> \
     --db-instance-class db.serverless
   ```
4. Wait for the temporary cluster and instance to become `available`, then run
   the checks against the temporary cluster's own endpoint. Use read-only access;
   do not repoint application or runtime configuration at the drill cluster.
5. Write the drill record (fields below) before any cleanup.
6. Remove the temporary cluster, in this order:
   1. Disable deletion protection only because the cluster is temporary:
      `aws rds modify-db-cluster --db-cluster-identifier <drill-cluster-id> --no-deletion-protection`
   2. Wait for the cluster to become `available`, then delete the temporary
      instance:
      `aws rds delete-db-instance --db-instance-identifier <drill-instance-id> --skip-final-snapshot`
   3. Wait for the instance to be deleted, then delete the temporary cluster:
      `aws rds delete-db-cluster --db-cluster-identifier <drill-cluster-id> --skip-final-snapshot`
   4. Confirm the temporary instance and cluster are gone.

## Drill record

The record is written before cleanup. The fields are:

| Field | Content |
| --- | --- |
| Run | operator, UTC start and end timestamps, stage, and source cluster identifier such as `<beta-cluster-id>` |
| Recovery point | point-in-time timestamp or snapshot identifier, and the restore command used |
| Duration | restore request time, time the temporary cluster became `available`, time the checks completed, and total elapsed time |
| Checks | each check performed, its observed result, and whether it matched the expected state at the chosen recovery point |
| Cleanup | temporary cluster and instance identifiers, time deletion protection was removed, and time both were deleted |

Typical checks are that the temporary cluster and instance reached `available`,
that the expected database exists, that the schema version and migration journal
match the state expected at the recovery point, and that a read-only query
returns the expected shape of data. Record what was observed, not what was
expected.

Never write credentials, connection secrets, or unredacted cloud diagnostics
into the record. A target stated in this runbook is not evidence that a drill
happened: the drill is performed only when an operator writes a record with the
fields above.
