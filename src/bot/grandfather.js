/**
 * Grant `roleId` to every current member of one guild.
 *
 * Deliberately knows nothing about the verified database: this is a per-guild
 * role backfill for servers adopting Gopherfy late, not a verification.
 * Grandfathered members still have to complete the real OTP flow in any other
 * Gopherfy server.
 *
 * @param {object} args
 * @param {import('discord.js').Guild} args.guild
 * @param {string} args.roleId
 * @param {object} args.log
 * @param {(progress: { processed: number, total: number }) => void} [args.onProgress]
 * @returns {Promise<{ total: number, granted: number, skipped: number, failed: number }>}
 */
async function grandfatherMembers({ guild, roleId, log, onProgress }) {
  // A failed full-guild fetch propagates -- there is nothing to iterate.
  const members = await guild.members.fetch();

  const total = members.size;
  let granted = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  for (const member of members.values()) {
    if (member.user?.bot || member.roles.cache.has(roleId)) {
      skipped += 1;
    } else {
      try {
        // discord.js's REST layer already queues and retries 429s, so a
        // plain sequential loop is the whole rate-limit strategy.
        await member.roles.add(roleId);
        granted += 1;
      } catch {
        // One member's missing permissions must not abort the rest.
        failed += 1;
      }
    }

    processed += 1;
    if (onProgress) {
      try {
        onProgress({ processed, total });
      } catch {
        // Progress reporting (and throttling it) is the caller's concern.
      }
    }
  }

  log.info({ event: 'grandfather_complete', guildId: guild.id, total, granted, skipped, failed });

  return { total, granted, skipped, failed };
}

module.exports = { grandfatherMembers };
