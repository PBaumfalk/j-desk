import { describe, it, expect } from 'vitest';
import { MappingStore, AnonCache, PLACEHOLDER_RE, batchLines, splitLines } from './mapping';

describe('PLACEHOLDER_RE', () => {
  it('erkennt beide dokumentierten Formate', () => {
    const text = 'A [[Person-QSEZB6]] B [PERSON-1] C [[email-BE2966]] D [IBAN-12]';
    expect(text.match(PLACEHOLDER_RE)).toEqual(['[[Person-QSEZB6]]', '[PERSON-1]', '[[email-BE2966]]', '[IBAN-12]']);
    expect('kein Platzhalter [Hinweis] hier'.match(PLACEHOLDER_RE)).toBeNull();
  });
});

describe('MappingStore', () => {
  it('ersetzt bekannte Platzhalter und meldet unbekannte', () => {
    const store = new MappingStore();
    store.record([{ original: 'Max Mustermann', placeholder: '[[Person-AB12]]' }]);
    const r = store.deanonymize('Hallo [[Person-AB12]], kennst du [[Person-ZZ99]]?');
    expect(r.text).toBe('Hallo Max Mustermann, kennst du [[Person-ZZ99]]?');
    expect(r.unknown).toEqual(['[[Person-ZZ99]]']);
    expect(store.size).toBe(1);
  });
});

describe('AnonCache', () => {
  it('cached Dateitexte und Namen', () => {
    const cache = new AnonCache();
    expect(cache.getFileText('f1')).toBeUndefined();
    cache.setFileText('f1', 'anon');
    expect(cache.getFileText('f1')).toBe('anon');
    cache.setName('Arztbrief Meier', '[[Person-X1]]-Brief');
    expect(cache.getName('Arztbrief Meier')).toBe('[[Person-X1]]-Brief');
  });
});

describe('Batching', () => {
  it('joint und splittet zeilenweise; null bei abweichender Zeilenzahl', () => {
    expect(batchLines(['a', 'b'])).toBe('a\nb');
    expect(splitLines('x\ny', 2)).toEqual(['x', 'y']);
    expect(splitLines('nur-eine-zeile', 2)).toBeNull();
  });
});
