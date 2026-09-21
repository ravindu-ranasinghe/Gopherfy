/**
 * Placeholder for the verified-role backfill engine.
 *
 * The /setup grandfather-existing option that drives this is not registered
 * yet (see src/bot/deploy.js), so nothing in the running bot can reach this
 * function. It exists so that handlers/buttons.js resolves at load time.
 * The real implementation lands in the follow-up PR.
 *
 * @returns {Promise<{ total: number, granted: number, skipped: number, failed: number }>}
 */
async function grandfatherMembers() {
  throw new Error('grandfather backfill not implemented yet');
}

module.exports = { grandfatherMembers };
