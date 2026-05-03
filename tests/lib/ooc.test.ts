import { describe, it, expect } from 'vitest';
import { isOocMessage, stripOocPrefix, OOC_PREFIX } from '@/lib/ooc';

describe('OOC message convention', () => {
  it('OOC_PREFIX is the literal "!" character', () => {
    expect(OOC_PREFIX).toBe('!');
  });

  it('isOocMessage detects messages starting with !', () => {
    expect(isOocMessage('!cosa fa il mio bonus arcano?')).toBe(true);
    expect(isOocMessage('! cosa fa il mio bonus arcano?')).toBe(true);
    expect(isOocMessage('  !ricapitoliamo')).toBe(true);
    expect(isOocMessage('cosa fai?')).toBe(false);
    expect(isOocMessage('Wow! che colpo!')).toBe(false); // ! mid-string is NOT OOC
    expect(isOocMessage('')).toBe(false);
  });

  it('stripOocPrefix removes the leading "!" + surrounding whitespace', () => {
    expect(stripOocPrefix('!cosa fa il mio bonus?')).toBe('cosa fa il mio bonus?');
    expect(stripOocPrefix('! cosa fa il mio bonus?')).toBe('cosa fa il mio bonus?');
    expect(stripOocPrefix('   !  cosa?  ')).toBe('cosa?  ');
    expect(stripOocPrefix('cosa fai?')).toBe('cosa fai?'); // not OOC, returns unchanged
  });
});
