import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, languageName } from '../lib/lang.js';

describe('detectLanguage', () => {
  test('spots a Spanish listing', () => {
    assert.equal(
      detectLanguage('Vendo mi carro 2010 Honda Accord, muy buenas condiciones, titulo limpio, corre bien'),
      'es',
    );
  });

  test('spots an English listing', () => {
    assert.equal(
      detectLanguage('Selling my 2010 Honda Accord, clean title, runs and drives great, cold ac, 140k miles'),
      'en',
    );
  });

  test('accents and inverted punctuation tip it Spanish', () => {
    assert.equal(detectLanguage('Se vende camioneta año 2008, ¿interesado? Llame para más información'), 'es');
  });

  test('returns null when there is too little text to be sure', () => {
    // Guessing on a five-word listing would just mislabel it.
    assert.equal(detectLanguage('nice truck'), null);
    assert.equal(detectLanguage(''), null);
    assert.equal(detectLanguage(null), null);
  });

  test('returns null on text with no signal either way', () => {
    assert.equal(detectLanguage('2010 2011 2012 2013 2014 2015 2016 2017 2018'), null);
  });
});

describe('languageName', () => {
  test('maps codes to labels for the dashboard', () => {
    assert.equal(languageName('es'), 'Spanish');
    assert.equal(languageName('en'), 'English');
  });

  test('returns null for anything unknown', () => {
    assert.equal(languageName('xx'), null);
    assert.equal(languageName(null), null);
  });
});
