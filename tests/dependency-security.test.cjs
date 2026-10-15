const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');

const appRequire = createRequire(path.resolve(__dirname, '../package.json'));
const serverRequire = createRequire(path.resolve(__dirname, '../server/package.json'));
const expressRequire = createRequire(serverRequire.resolve('express'));
const qs = expressRequire('qs');
const proxyaddr = expressRequire('proxy-addr');

test('proxy-addr does not trust arbitrary IPv4 addresses via IPv6 subnets', () => {
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    assert.equal(proxyaddr.compile(subnet)('203.0.113.1'), false);
  }
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust('10.1.2.3'), true);
    assert.equal(trust('203.0.113.1'), false);
  }
});

test('qs safely serializes an attacker-controlled constructor.isBuffer', () => {
  for (const options of [{ plainObjects: true }, { allowPrototypes: true }]) {
    const parsed = qs.parse('x[constructor][isBuffer]=y', options);
    assert.doesNotThrow(() => qs.stringify(parsed));
  }
  assert.equal(qs.stringify({ value: Buffer.from('safe') }), 'value=safe');
});

test('qs enforces comma array limits for both flat and bracket keys', () => {
  const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };
  for (const query of ['a=1,2,3,4', 'a[]=1,2,3,4']) {
    assert.throws(() => qs.parse(query, options), RangeError);
  }
  assert.deepEqual(qs.parse('a=1,2,3', options).a, ['1', '2', '3']);
});

test('every existing UUID consumer resolves a patched CommonJS-compatible UUID', () => {
  const consumers = [
    [appRequire, '@expo/browser-polyfill'],
    [appRequire, '@expo/bunyan'],
    [appRequire, '@expo/rudder-sdk-node'],
    [appRequire, 'xcode'],
    [serverRequire, 'node-cron'],
  ];
  for (const [requireFrom, name] of consumers) {
    const consumerRequire = createRequire(requireFrom.resolve(`${name}/package.json`));
    assert.equal(consumerRequire('uuid/package.json').version, '11.1.1', name);
    const uuid = consumerRequire('uuid');
    assert.ok(uuid.validate(uuid.v1()), name);
    assert.ok(uuid.validate(uuid.v4()), name);
    for (const method of ['v3', 'v5']) {
      assert.throws(() => uuid[method]('x', uuid[method].DNS, new Uint8Array(8), 4), RangeError);
      const buffer = new Uint8Array(16);
      assert.equal(uuid[method]('x', uuid[method].DNS, buffer), buffer);
    }
    assert.throws(() => uuid.v6({}, new Uint8Array(8), 4), RangeError);
  }
});

test('node-cron still creates, executes, and stores tasks with UUID identifiers', () => {
  const cron = serverRequire('node-cron');
  let runs = 0;
  const task = cron.schedule('0 5 * * *', () => { runs += 1; }, {
    scheduled: false,
    timezone: 'America/New_York',
  });
  try {
    task.now();
    assert.equal(runs, 1);
    assert.ok(serverRequire('uuid').validate(task.options.name));
    assert.equal(cron.getTasks().get(task.options.name), task);
  } finally {
    task.stop();
    cron.getTasks().delete(task.options.name);
  }
});

test('Express still handles proxy IPs, nested query parameters, and form bodies', async () => {
  const express = serverRequire('express');
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.urlencoded({ extended: true }));
  app.post('/echo', (req, res) => res.json({ ip: req.ip, query: req.query, body: req.body }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/echo?filter[name]=safe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.1',
      },
      body: 'items[0]=one&items[1]=two',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ip: '203.0.113.1',
      query: { filter: { name: 'safe' } },
      body: { items: ['one', 'two'] },
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
