#!/usr/bin/env node
/**
 * osa-admin — operator CLI for HITL recovery.
 *
 * Commands:
 *   osa-admin inbox pending
 *   osa-admin inbox set-action <inbox_id> <action> [--hint "..."]
 *   osa-admin inbox expire-sweep
 */

import { InboxStore } from '../core/agents/hitl/inbox-store';

function main(argv: string[]): number {
  const [, , group, sub, ...rest] = argv;
  if (group !== 'inbox') return usage();
  const dbPath = process.env.OSA_INBOX_DB_PATH || '.osa-inbox.sqlite';
  const store = new InboxStore(dbPath);

  try {
    if (sub === 'pending') {
      const rows = store.pending();
      if (rows.length === 0) {
        console.log('(no pending inbox entries)');
        return 0;
      }
      for (const r of rows) {
        console.log(`${r.id}\t${r.kind}\t${r.status}\tattempt=${r.attempt_id}\texpires=${r.expires_at}`);
      }
      return 0;
    }
    if (sub === 'set-action') {
      const id = rest[0];
      const action = rest[1];
      if (!id || !action) return usage();
      const hintIdx = rest.indexOf('--hint');
      const hint = hintIdx >= 0 ? rest[hintIdx + 1] : undefined;
      const entry = store.get(id);
      if (!entry) {
        console.error(`unknown inbox entry: ${id}`);
        return 2;
      }
      const expected = JSON.parse(entry.expected_actions) as string[];
      if (!expected.includes(action)) {
        console.error(`action "${action}" not in expected: ${expected.join(', ')}`);
        return 2;
      }
      // Force-transition from whatever status to mapped.
      const ok =
        store.transition(entry.id, entry.status as any, 'mapped', {
          mapping_confidence: 1,
          mapped_action: action,
          stripped_reply: hint ? `admin-cli: ${hint}` : `admin-cli set-action ${action}`,
        });
      if (!ok) {
        console.error(`failed to transition from ${entry.status} to mapped`);
        return 3;
      }
      console.log(`mapped ${id} -> ${action}`);
      return 0;
    }
    if (sub === 'expire-sweep') {
      const expired = store.expireDue();
      console.log(`expired ${expired.length} entries`);
      return 0;
    }
    return usage();
  } finally {
    store.close();
  }
}

function usage(): number {
  console.error(`usage:
  osa-admin inbox pending
  osa-admin inbox set-action <inbox_id> <action> [--hint "..."]
  osa-admin inbox expire-sweep
`);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}
