// Reviewed bounded command for unchanged Service images. Never migrates or writes
// application state. Missing image paths/DB permissions terminate the task.
const fs = require('node:fs');
const read = file => fs.readFileSync(file);
// A hard deadline covers synchronous file hashing, secret lookup, connection,
// queries and cleanup. This task is an isolated read-only process; termination
// cannot interrupt a migration or application write.
const deadline = setTimeout(() => { console.error('Runtime evidence hard deadline exceeded'); process.exit(1); }, 30_000);
async function main() {
  const policyBytes = read('/app/dist/tasks/runtime-policy.json');
  const journalBytes = read('/app/drizzle/meta/_journal.json');
  const policy = parseJson(policyBytes); const journal = parseJson(journalBytes);
  if (journal.version !== '7' || journal.dialect !== 'postgresql' || !Array.isArray(journal.entries) || !journal.entries.length) throw new Error('Unsupported image journal');
  const selected = journal.entries.map((entry, index) => {
    if (entry.idx !== index || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) || !Number.isSafeInteger(entry.when)) throw new Error('Malformed image migration');
    return { id: sha256(read(`/app/drizzle/${entry.tag}.sql`)), created_at: entry.when };
  });
  const db = await require('/app/dist/db/index.js').getPostgresClient();
  try {
    const result = await db.begin('isolation level repeatable read read only', async sql => {
      await sql`set local statement_timeout = '15000ms'`;
      await sql`set local lock_timeout = '2000ms'`;
      const versions = await sql`select version from application_schema_versions where component = 'anywear-service'`;
      const applied = await sql`select hash as id, created_at from drizzle.__drizzle_migrations order by created_at, hash`;
      if (versions.length !== 1 || !Number.isSafeInteger(versions[0].version) || !applied.length || applied.length > 1024) throw new Error('Applied database evidence unavailable');
      return { applied_schema_version: versions[0].version, applied_migration_ids: applied.map(row => ({ id: row.id, created_at: Number(row.created_at) })) };
    });
    const output = { record_type: 'anywear_read_only_runtime', schema_version: 1,
      service_sha: process.env.SERVICE_COMMIT_SHA, image_digest: process.env.IMAGE_DIGEST,
      policy_file_sha256: sha256(policyBytes), policy_content_sha256: contentHash(policy),
      selected_journal_sha256: contentHash(journal), selected_migration_ids: selected,
      ...result, observed_applied_journal_sha256: contentHash(result.applied_migration_ids) };
    console.log(`ANYWEAR_RUNTIME_EVIDENCE:${JSON.stringify(output)}`);
  } finally { await db.end({ timeout: 5 }); }
}
main().then(() => clearTimeout(deadline)).catch(() => { console.error('Bounded read-only runtime evidence failed'); process.exit(1); });
