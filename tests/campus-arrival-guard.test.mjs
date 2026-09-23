import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext, createContext } from 'node:vm';

const source = readFileSync(new URL('../public/campus-arrival-guard.js', import.meta.url), 'utf8');
const campusPosition = { coords: { latitude: 37.6, longitude: 126.96, accuracy: 10 } };

function fixture() {
  const root = { dataset: { originMode: 'gps' } };
  const elements = new Map();
  const element = (name) => {
    if (!elements.has(name)) elements.set(name, { hidden: false, textContent: '', className: '' });
    return elements.get(name);
  };
  const modeObservers = [];
  let deferGps = false;
  let finishGps = null;
  const context = createContext({
    document: {
      documentElement: root,
      getElementById: element,
      querySelector: element,
      addEventListener() {},
      hidden: false
    },
    localStorage: { getItem: () => 'granted' },
    navigator: {
      geolocation: {
        getCurrentPosition(success) {
          if (deferGps) finishGps = success;
          else success(campusPosition);
        }
      }
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        destinationSeq: 2,
        stations: [{ seq: 2, stationNm: '상명대정문', gpsY: 37.6, gpsX: 126.96 }]
      })
    }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target) { if (target === root) modeObservers.push(this); }
    },
    window: { addEventListener() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval() {},
    queueMicrotask
  });
  runInContext(source, context);
  return {
    root,
    element,
    check: () => runInContext('checkCampusArrival()', context),
    changeOrigin(mode) {
      root.dataset.originMode = mode;
      modeObservers.forEach((observer) => observer.callback());
    },
    deferGps() { deferGps = true; },
    finishGps() {
      assert.ok(finishGps, 'a GPS request should be pending');
      finishGps(campusPosition);
    }
  };
}

test('real GPS at campus shows arrival, then manual place clears overlay', async () => {
  const app = fixture();
  await app.check();
  assert.equal(app.root.dataset.campusArrived, 'true');
  assert.equal(app.element('totalTime').textContent, '0분');
  assert.equal(app.element('showRouteButton').hidden, true);

  app.changeOrigin('manual-place');
  assert.equal(app.root.dataset.campusArrived, undefined);
  assert.equal(app.element('showRouteButton').hidden, false);
  await app.check();
  assert.equal(app.root.dataset.campusArrived, undefined);
});

test('GPS response completing after manual place selection cannot show arrival', async () => {
  const app = fixture();
  app.deferGps();
  const check = app.check();
  app.changeOrigin('manual-place');
  app.finishGps();
  await check;
  assert.equal(app.root.dataset.campusArrived, undefined);
  assert.notEqual(app.element('leaveHeadline').textContent, '이미 상명대학교에 도착했어요');
});

test('manual stop is not overridden, and returning to GPS restores arrival', async () => {
  const app = fixture();
  await app.check();
  app.changeOrigin('manual-stop');
  assert.equal(app.root.dataset.campusArrived, undefined);
  await app.check();
  assert.equal(app.root.dataset.campusArrived, undefined);
  app.changeOrigin('gps');
  await app.check();
  assert.equal(app.root.dataset.campusArrived, 'true');
});
