// __PROTOCOL__ 驱动测试：共用契约套件（样本回放，零真实费用）+ 本驱动特有场景。
// 生成后先把 fixtures/ 里的样本补齐（来源写进 provenance.md），再实现 index.js 的 TODO。
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import driver from './index.js';
import { runVideoDriverContract, contractChannel, createScriptedFetch, consoleCapture } from '../../contract-test.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const channel = contractChannel({ kind: 'video', driver: '__PROTOCOL__', modelMap: { video: 'REPLACE_ME' } });

const build = ({ fetchImpl, logger }) => driver.create(channel, { logger, deps: { fetchImpl } });

runVideoDriverContract({
  title: '__PROTOCOL__ 契约',
  build,
  fixtures: {
    submitAccepted: fixture('submit-accepted.json'),
    submitRejected: fixture('submit-rejected.json'),
    queryRunning: fixture('query-running.json'),
    querySucceeded: fixture('query-succeeded.json'),
    queryFailed: fixture('query-failed.json'),
  },
});

test('__PROTOCOL__：占位（实现后替换为协议特有场景）', () => {
  assert.ok(driver.id === '__PROTOCOL__');
});
