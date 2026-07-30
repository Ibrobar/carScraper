// The negation cases are the reason this file is the biggest test in the repo.
// A good car wrongly rejected is invisible — you never learn it happened — so
// the false-negative cases matter more than the false-positive ones.
//
// When you find a phrasing the scanner gets wrong, ADD IT HERE FIRST, then fix
// lib/defects.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanDefects, normalizeText } from '../lib/defects.js';

const rejects = (text) => scanDefects(text).rejected;
const reasonsFor = (text) => scanDefects(text).reasons;
const flagsFor = (text) => scanDefects(text).flags;

describe('normalizeText', () => {
  test("strips apostrophes so won't and wont are the same string", () => {
    assert.equal(normalizeText("Won't Start"), 'wont start');
    assert.equal(normalizeText('Doesn’t run'), 'doesnt run');
  });

  test('collapses whitespace and lowercases', () => {
    assert.equal(normalizeText('  RUNS   GREAT \n ok '), 'runs great ok');
  });
});

describe('rejects unambiguous drivetrain trouble', () => {
  const cases = [
    ['needs engine', 'defect_engine'],
    ['Needs a motor, otherwise clean', 'defect_engine'],
    ['blown head gasket', 'defect_engine'],
    ['engine knock when cold', 'defect_engine'],
    ['rod knock', 'defect_engine'],
    ['motor is seized', 'defect_engine'],
    ['it overheats after 10 minutes', 'defect_engine'],
    ['bad transmission', 'defect_transmission'],
    ['transmission slipping in 3rd', 'defect_transmission'],
    ['no reverse', 'defect_transmission'],
    ['slips gears going uphill', 'defect_transmission'],
    ["won't start", 'defect_not_running'],
    ['does not start', 'defect_not_running'],
    ['not running, sitting in driveway', 'defect_not_running'],
    ['selling for parts', 'defect_parts_only'],
    ['parts only', 'defect_parts_only'],
    ['mechanic special', 'defect_parts_only'],
  ];

  for (const [text, reason] of cases) {
    test(`"${text}" -> ${reason}`, () => {
      const result = scanDefects(text);
      assert.equal(result.rejected, true, `expected rejection for "${text}"`);
      assert.ok(
        result.reasons.includes(reason),
        `expected ${reason}, got [${result.reasons.join(', ')}]`,
      );
    });
  }
});

describe('negation — these must all PASS', () => {
  // Every one of these is a car worth buying that a naive keyword match kills.
  const cases = [
    'runs great, no engine issues',
    'no transmission problems at all',
    'new transmission installed last month',
    'motor recently rebuilt, drives perfect',
    'no rod knock, no leaks',
    'engine was replaced at 120k',
    'rebuilt transmission, shifts great',
    'never had engine trouble',
    'does not smoke, does not leak',
    'no overheating issues',
    'transmission recently serviced',
    'brand new motor',
    'zero engine problems',
  ];

  for (const text of cases) {
    test(`"${text}" passes`, () => {
      const result = scanDefects(text);
      assert.equal(
        result.rejected,
        false,
        `wrongly rejected "${text}" for [${result.reasons.join(', ')}]`,
      );
    });
  }
});

describe('the "needs X" family — regressions from real listings', () => {
  // Every one of these reached the dashboard before the pattern rules existed.
  const cases = [
    ['NEEDS TRANSMISSION', 'defect_transmission'],
    ['needs transmission', 'defect_transmission'],
    ['runs great, just needs transmission', 'defect_transmission'],
    ['just needs a transmission', 'defect_transmission'],
    ['needs a new transmission', 'defect_transmission'],
    ['needs new trans', 'defect_transmission'],
    ['needs tranny', 'defect_transmission'],
    ['needs another motor', 'defect_engine'],
    ['just needs an engine', 'defect_engine'],
    ['needs a good motor', 'defect_engine'],
    ['transmission work needed', 'defect_transmission'],
    ['needs transmission work', 'defect_transmission'],
    ['trans slips', 'defect_transmission'],
    ['transmission slips a little around 3rd gear', 'defect_transmission'],
    ['slipping trans', 'defect_transmission'],
    ['good candidate to partout', 'defect_parts_only'],
    ['going to part it out', 'defect_parts_only'],
  ];

  for (const [text, reason] of cases) {
    test(`"${text}" -> ${reason}`, () => {
      const result = scanDefects(text);
      assert.equal(result.rejected, true, `expected rejection for "${text}"`);
      assert.ok(
        result.reasons.includes(reason),
        `expected ${reason}, got [${result.reasons.join(', ')}]`,
      );
    });
  }

  test('"just" no longer reads as a repair', () => {
    // "just" was in the repair-verb list, so "just needs transmission" was
    // cancelled as though the transmission had been replaced.
    assert.equal(scanDefects('just needs transmission').rejected, true);
  });

  test('but a genuine repair still cancels', () => {
    assert.equal(scanDefects('just replaced the transmission').rejected, false);
    assert.equal(scanDefects('just rebuilt the motor').rejected, false);
  });

  test('a negated need still passes', () => {
    assert.equal(scanDefects('does not need a transmission').rejected, false);
    assert.equal(scanDefects('doesnt need an engine').rejected, false);
  });

  test('"trans" does not fire on unrelated words', () => {
    assert.equal(scanDefects('needs transport to your driveway').rejected, false);
  });

  test('"mechanical issues" flags rather than rejects', () => {
    const result = scanDefects('It starts, runs, and drives, but it does have mechanical issues');
    assert.ok(result.flags.includes('mechanical_issues') || result.rejected === false);
  });
});

describe('Spanish — 31% of DFW listings, and they used to bypass every filter', () => {
  const cases = [
    ['no arranca', 'defect_not_running'],
    ['el carro no prende', 'defect_not_running'],
    ['no enciende, esta parado', 'defect_not_running'],
    ['no camina', 'defect_not_running'],
    ['motor fundido', 'defect_engine'],
    ['tiene el motor malo', 'defect_engine'],
    ['se calienta mucho', 'defect_engine'],
    ['necesita motor', 'defect_engine'],
    ['necesita un motor nuevo', 'defect_engine'],
    ['NECESITA TRANSMISION', 'defect_transmission'],
    ['necesita transmisión', 'defect_transmission'],
    ['necesita una transmision nueva', 'defect_transmission'],
    ['transmision mala', 'defect_transmission'],
    ['no tiene reversa', 'defect_transmission'],
    ['la transmision patina', 'defect_transmission'],
    ['se vende para partes', 'defect_parts_only'],
    ['lo vendo por partes', 'defect_parts_only'],
    ['para refacciones', 'defect_parts_only'],
  ];

  for (const [text, reason] of cases) {
    test(`"${text}" -> ${reason}`, () => {
      const result = scanDefects(text);
      assert.equal(result.rejected, true, `expected rejection for "${text}"`);
      assert.ok(
        result.reasons.includes(reason),
        `expected ${reason}, got [${result.reasons.join(', ')}]`,
      );
    });
  }

  test('accents are folded, so either spelling works', () => {
    assert.equal(scanDefects('necesita transmisión').rejected, true);
    assert.equal(scanDefects('necesita transmision').rejected, true);
    assert.equal(scanDefects('TRANSMISIÓN DAÑADA').rejected, true);
  });

  describe('healthy Spanish listings must PASS', () => {
    const good = [
      'corre y camina bien, aire frio, titulo limpio',
      'motor nuevo, transmision nueva',
      'no tiene problemas mecanicos',
      'sin fallas, muy buenas condiciones',
      'transmision reconstruida recientemente',
      'el motor fue reparado el año pasado',
      'nunca se ha calentado',
      'todo funciona bien',
      'vendo mi carro 2010 honda accord, 140 mil millas, buenas condiciones',
    ];
    for (const text of good) {
      test(`"${text}"`, () => {
        const result = scanDefects(text);
        assert.equal(
          result.rejected, false,
          `wrongly rejected for [${result.reasons.join(', ')}]`,
        );
      });
    }
  });

  test('"patina" alone does not fire — it is an English word too', () => {
    // "great patina" is a selling point on a classic, not a slipping gearbox.
    assert.equal(scanDefects('beautiful original paint with great patina').rejected, false);
  });

  test('"no funciona" flags rather than rejects — it is usually the AC', () => {
    const result = scanDefects('el aire no funciona pero corre bien');
    assert.equal(result.rejected, false);
  });

  test('Spanish negators cancel the same way English ones do', () => {
    assert.equal(scanDefects('sin problemas de transmision').rejected, false);
    assert.equal(scanDefects('nunca ha tenido motor malo').rejected, false);
  });

  test('a "no" from an earlier comma-clause does not cancel a later defect', () => {
    // Verbatim from a live listing that was showing as good. The "no" in
    // "ya no la moví" was reaching forward to cancel "por partes".
    const text = 'Detalles en el motor , se calentó y ya no la moví , se va completa o por partes';
    const result = scanDefects(text);
    assert.equal(result.rejected, true, `not rejected: [${result.cancelled.join(', ')}] cancelled`);
    assert.ok(result.reasons.includes('defect_parts_only'));
    assert.ok(result.reasons.includes('defect_engine'), 'se calentó should count too');
  });

  test('a distant negator does not reach the defect', () => {
    // Verbatim from a live listing. The "no" belongs to "frena" (doesn't
    // brake); it must not cancel "para partes" four words later.
    const text = 'prende y corre pero el booster de los frenos tira aceite y no frena lo vendo asi para partes';
    const result = scanDefects(text);
    assert.equal(result.rejected, true, `cancelled: [${result.cancelled.join(', ')}]`);
    assert.ok(result.reasons.includes('defect_parts_only'));
  });

  test('the comma clause break does not break ordinary negation', () => {
    // The negator sits AFTER the comma here, so it still applies.
    assert.equal(scanDefects('corre bien, sin problemas de transmision').rejected, false);
    assert.equal(scanDefects('runs great, no engine issues').rejected, false);
  });

  test('"pero" breaks the clause like "but" does', () => {
    // The "no" belongs to the first clause and must not clear the second.
    assert.equal(scanDefects('no tiene golpes pero necesita transmision').rejected, true);
  });

  test('mixed Spanish and English in one listing still works', () => {
    assert.equal(scanDefects('Clean title, corre bien, no engine issues').rejected, false);
    assert.equal(scanDefects('Runs good but necesita transmision').rejected, true);
  });
});

describe('negation does not leak across clauses', () => {
  test('"No rust. Engine knock." still rejects', () => {
    // The "no" belongs to the previous sentence. If the lookback window ignored
    // sentence boundaries this would wrongly pass.
    assert.equal(rejects('No rust. Engine knock.'), true);
    assert.ok(reasonsFor('No rust. Engine knock.').includes('defect_engine'));
  });

  test('"no rust but transmission slipping" still rejects', () => {
    assert.equal(rejects('no rust but transmission slipping'), true);
  });

  test('"no dents, no scratches. needs engine" still rejects', () => {
    assert.equal(rejects('no dents, no scratches. needs engine'), true);
  });

  test('a strong positive does NOT cancel a strong negative', () => {
    // "Runs great otherwise" doesn't make a car that needs an engine a good buy.
    assert.equal(rejects('Needs engine work. Runs great otherwise.'), true);
  });
});

describe('weak signals flag rather than reject', () => {
  test('check engine light is a badge, not a rejection', () => {
    const result = scanDefects('clean truck, check engine light is on');
    assert.equal(result.rejected, false);
    assert.ok(result.flags.includes('check_engine_light'));
  });

  test('"as is" alone flags', () => {
    const result = scanDefects('selling as is');
    assert.equal(result.rejected, false);
    assert.ok(result.flags.includes('sold_as_is'));
  });

  test('a clear positive clears the soft warnings', () => {
    // "sold as is but runs and drives great" is a car worth looking at.
    const result = scanDefects('sold as is but runs and drives great');
    assert.equal(result.rejected, false);
    assert.deepEqual(result.flags, []);
  });

  test('oil leak flags but does not reject', () => {
    const result = scanDefects('small oil leak, otherwise fine');
    assert.equal(result.rejected, false);
    assert.ok(result.flags.includes('oil_leak'));
  });
});

describe('word boundaries', () => {
  test('"cannot run" does not trip the "not run" rule', () => {
    assert.equal(rejects('cannot run out of gas'), false);
  });

  test('"seized" inside another word does not match', () => {
    assert.equal(rejects('unseized opportunity'), false);
  });

  test('substring of a longer phrase does not double-fire', () => {
    // "not running" must match as itself, not also as "not run".
    const reasons = reasonsFor('not running');
    assert.deepEqual(reasons, ['defect_not_running']);
  });
});

describe('edge cases', () => {
  test('empty and null input are safe', () => {
    for (const input of ['', null, undefined, '   ']) {
      const result = scanDefects(input);
      assert.equal(result.rejected, false);
      assert.deepEqual(result.reasons, []);
    }
  });

  test('a clean listing produces nothing', () => {
    const result = scanDefects('2010 Toyota Camry, 140k miles, cold ac, clean title');
    assert.equal(result.rejected, false);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.flags, []);
  });

  test('cancelled hits are recorded for auditing', () => {
    const result = scanDefects('no rod knock');
    assert.ok(result.cancelled.includes('rod knock'));
  });

  test('multiple distinct problems yield multiple reasons', () => {
    const reasons = reasonsFor('bad transmission and blown motor');
    assert.ok(reasons.includes('defect_transmission'));
    assert.ok(reasons.includes('defect_engine'));
  });

  test('flags never duplicate', () => {
    const flags = flagsFor('check engine light, engine light on, check engine light again');
    assert.equal(flags.filter((f) => f === 'check_engine_light').length, 1);
  });
});
