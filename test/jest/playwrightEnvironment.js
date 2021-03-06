/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const NodeEnvironment = require('jest-environment-node');
const registerFixtures = require('./fixtures');
const { toMatchImageSnapshot: jestImageSnapshot } = require('jest-image-snapshot');
const os = require('os');
const path = require('path');
const platform = os.platform();

const browserName = process.env.BROWSER || 'chromium';

class PlaywrightEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this.fixturePool = new FixturePool();
    const testOptions = {};
    testOptions.MAC = platform === 'darwin';
    testOptions.LINUX = platform === 'linux';
    testOptions.WIN = platform === 'win32';
    testOptions.CHROMIUM = browserName === 'chromium';
    testOptions.FFOX = browserName === 'firefox';
    testOptions.WEBKIT = browserName === 'webkit';
    testOptions.USES_HOOKS = process.env.PWCHANNEL === 'wire';
    testOptions.CHANNEL = !!process.env.PWCHANNEL;
    testOptions.HEADLESS = !!valueFromEnv('HEADLESS', true);
    this.global.testOptions = testOptions;

    this.global.registerFixture = (name, fn) => {
      this.fixturePool.registerFixture(name, 'test', fn);
    };
    this.global.registerWorkerFixture = (name, fn) => {
      this.fixturePool.registerFixture(name, 'worker', fn);
    };
    registerFixtures(this.global);
  }

  async setup() {
    await super.setup();
  }

  async teardown() {
    await this.fixturePool.teardownScope('worker');
    await super.teardown();
  }

  runScript(script) {
    return super.runScript(script);
  }

  async handleTestEvent(event, state) {
    if (event.name === 'setup') {
      const beforeEach = this.global.beforeEach;
      this.global.beforeEach = fn => {
        return beforeEach(async () => {
          return await this.fixturePool.resolveParametersAndRun(fn);
        });
      }
      const describeSkip = this.global.describe.skip;
      this.global.describe.skip = (...args) => {
        if (args.length = 1)
          return args[0] ? describeSkip : this.global.describe;
        return describeSkip(...args);
      };
      this.global.describe.fail = this.global.describe.skip;

      const itSkip = this.global.it.skip;
      this.global.it.skip = (...args) => {
        if (args.length = 1)
          return args[0] ? itSkip : this.global.it;
        return itSkip(...args);
      };
      this.global.it.fail = this.global.it.skip;
      this.global.it.slow = () => this.global.it;

      function toMatchImageSnapshot(received, fileName) {
        return jestImageSnapshot.call(this, received, {
          customDiffConfig: { threshold: 0.2 },
          customSnapshotsDir: path.join(__dirname, '..', `golden-${browserName}`),
          customSnapshotIdentifier: fileName
        });
      };
      this.global.expect.extend({ toMatchImageSnapshot });
    }
    if (event.name === 'test_start') {
      const fn = event.test.fn;
      event.test.fn = async () => {
        try {
          return await this.fixturePool.resolveParametersAndRun(fn);
        } finally {
          await this.fixturePool.teardownScope('test');
        }
      };
    }
  }
}

class Fixture {
  constructor(pool, name, scope, fn) {
    this.pool = pool;
    this.name = name;
    this.scope = scope;
    this.fn = fn;
    this.deps = fixtureParameterNames(this.fn);
    this.usages = new Set();
    this.value = null;
  }

  async setup() {
    for (const name of this.deps) {
      await this.pool.setupFixture(name);
      this.pool.instances.get(name).usages.add(this.name);
    }

    const params = {};
    for (const n of this.deps)
      params[n] = this.pool.instances.get(n).value;
    let setupFenceFulfill;
    let setupFenceReject;
    const setupFence = new Promise((f, r) => { setupFenceFulfill = f; setupFenceReject = r; });
    const teardownFence = new Promise(f => this._teardownFenceCallback = f);
    this._tearDownComplete = this.fn(params, async value => {
      this.value = value;
      setupFenceFulfill();
      await teardownFence;
    }).catch(e => setupFenceReject(e));
    await setupFence;
    this._setup = true;
  }

  async teardown() {
    if (this._teardown)
      return;
    this._teardown = true;
    for (const name of this.usages) {
      const fixture = this.pool.instances.get(name);
      if (!fixture)
        continue;
      await fixture.teardown();
    }
    if (this._setup)
      this._teardownFenceCallback();
    await this._tearDownComplete;
    this.pool.instances.delete(this.name);
  }
}

class FixturePool {
  constructor() {
    this.registrations = new Map();
    this.instances = new Map();
  }

  registerFixture(name, scope, fn) {
    this.registrations.set(name, { scope, fn });
  }

  async setupFixture(name) {
    let fixture = this.instances.get(name);
    if (fixture)
      return fixture;

    if (!this.registrations.has(name))
      throw new Error('Unknown fixture: ' + name);
    const { scope, fn } = this.registrations.get(name);
    fixture = new Fixture(this, name, scope, fn);
    this.instances.set(name, fixture);
    await fixture.setup();
    return fixture;
  }

  async teardownScope(scope) {
    for (const [name, fixture] of this.instances) {
      if (fixture.scope === scope)
        await fixture.teardown();
    }
  }

  async resolveParametersAndRun(fn) {
    const names = fixtureParameterNames(fn);
    for (const name of names)
      await this.setupFixture(name);
    const params = {};
    for (const n of names)
      params[n] = this.instances.get(n).value; 
    await fn(params);
  }
}

exports.getPlaywrightEnv = () => PlaywrightEnvironment;
exports.default = exports.getPlaywrightEnv();

function fixtureParameterNames(fn) {
  const text = fn.toString();
  const match = text.match(/async(?:\s+function)?\s*\(\s*{\s*([^}]*)\s*}/);
  if (!match || !match[1].trim())
    return [];
  let signature = match[1];
  return signature.split(',').map(t => t.trim());
}

function valueFromEnv(name, defaultValue) {
  if (!(name in process.env))
    return defaultValue;
  return JSON.parse(process.env[name]);
}
