const { Collection } = require('discord.js');

const { grandfatherMembers } = require('../grandfather');
const {
  createMockMember,
  createMockGuild,
  createSilentLogger,
} = require('./factories/interaction');

const ROLE = 'verified-role';

function run(memberList, extra = {}) {
  const guild = createMockGuild({ memberList });
  const log = createSilentLogger();
  return { guild, log, promise: grandfatherMembers({ guild, roleId: ROLE, log, ...extra }) };
}

describe('grandfatherMembers', () => {
  test('mixed guild -> granted/skipped/failed sum to total', async () => {
    const plain = createMockMember({ id: 'a' });
    const bot = createMockMember({ id: 'b', isBot: true });
    const already = createMockMember({ id: 'c', hasRole: ROLE });
    const broken = createMockMember({
      id: 'd',
      add: jest.fn().mockRejectedValue(new Error('missing permissions')),
    });

    const { promise, log } = run([plain, bot, already, broken]);
    const result = await promise;

    expect(result).toEqual({ total: 4, granted: 1, skipped: 2, failed: 1 });
    expect(result.granted + result.skipped + result.failed).toBe(result.total);
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'grandfather_complete', guildId: 'guild1', total: 4 }),
    );
  });

  test('bots are skipped without a role call', async () => {
    const bot = createMockMember({ id: 'b', isBot: true });
    const { promise } = run([bot]);

    await expect(promise).resolves.toEqual({ total: 1, granted: 0, skipped: 1, failed: 0 });
    expect(bot.roles.add).not.toHaveBeenCalled();
  });

  test('members already holding the role are skipped without a role call', async () => {
    const already = createMockMember({ id: 'c', hasRole: ROLE });
    const { promise } = run([already]);

    await expect(promise).resolves.toEqual({ total: 1, granted: 0, skipped: 1, failed: 0 });
    expect(already.roles.add).not.toHaveBeenCalled();
  });

  test('one rejecting roles.add is counted and later members still get the role', async () => {
    const broken = createMockMember({
      id: 'a',
      add: jest.fn().mockRejectedValue(new Error('403')),
    });
    const after = createMockMember({ id: 'b' });

    const { promise } = run([broken, after]);
    const result = await promise;

    expect(result).toEqual({ total: 2, granted: 1, skipped: 0, failed: 1 });
    expect(after.roles.add).toHaveBeenCalledWith(ROLE);
  });

  test('a throwing onProgress does not break the loop', async () => {
    const onProgress = jest.fn(() => {
      throw new Error('editReply blew up');
    });
    const members = [createMockMember({ id: 'a' }), createMockMember({ id: 'b' })];

    const { promise } = run(members, { onProgress });
    const result = await promise;

    expect(result).toEqual({ total: 2, granted: 2, skipped: 0, failed: 0 });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({ processed: 2, total: 2 });
  });

  test('empty guild -> all zeroes', async () => {
    const { promise } = run([]);
    await expect(promise).resolves.toEqual({ total: 0, granted: 0, skipped: 0, failed: 0 });
  });

  test('never touches the verified database', async () => {
    // The module must not be able to reach the db at all -- a require of
    // ./db here would be the bug this whole feature has to avoid.
    const source = require('fs').readFileSync(require.resolve('../grandfather'), 'utf8');
    expect(source).not.toMatch(/require\(['"]\.\/db['"]\)/);
    expect(source).not.toMatch(/addVerifiedHmac|hashEmail|verified_users/);
  });

  test('a failed full-guild fetch propagates', async () => {
    const guild = createMockGuild({
      members: { fetch: jest.fn().mockRejectedValue(new Error('gateway timeout')) },
    });
    await expect(
      grandfatherMembers({ guild, roleId: ROLE, log: createSilentLogger() }),
    ).rejects.toThrow('gateway timeout');
  });

  test('iterates the fetched Collection, not the cache', async () => {
    const member = createMockMember({ id: 'a' });
    const fetched = new Collection([['a', member]]);
    const guild = createMockGuild({ members: { fetch: jest.fn().mockResolvedValue(fetched) } });

    await grandfatherMembers({ guild, roleId: ROLE, log: createSilentLogger() });

    expect(guild.members.fetch).toHaveBeenCalledWith();
    expect(member.roles.add).toHaveBeenCalledWith(ROLE);
  });
});
