import { describe, it, expect } from 'vitest';
import { isMechanicalIntent } from '@/ai/master/rag/intent';

describe('isMechanicalIntent — Italian patterns', () => {
  it.each([
    'tiro percezione',
    'Tira investigazione',
    'tiro salvezza destrezza',
    'salvataggio su forza',
    'lancio palla di fuoco',
    'Lancia dardo magico',
    'attacco il goblin',
    'colpisco con la spada',
    'uso pozione di guarigione',
    'attivo Channel Divinity',
    'bevo la pozione',
    'mi muovo verso la porta',
    'mi nascondo dietro la colonna',
    'schivo',
    'disingaggio',
    'iniziativa',
    'riposo breve',
    'riposo lungo',
    'cerco indizi',
    'esamino la statua',
    'spendo ispirazione',
    // ── 2026-05-21: inspection/investigation/check verbs added after
    // session 6b11f581 where "ispeziono il sigillo" bypassed the gate
    // and the master narrated the outcome without asking for a roll.
    'Ispeziono il sigillo di ferro',
    'ispeziona la porta',
    'Investigo la stanza segreta',
    'investiga il pavimento',
    'Indago sul mercante',
    'Studio l\'iscrizione sul muro',
    'Decifro la pergamena arcana',
    'analizzo la trappola',
    'scruto le ombre',
    'tasto il muro per trovare un meccanismo',
    'ascolto dietro la porta',
    'origlio la conversazione',
    // "faccio un tiro/prova" — explicit roll declarations
    'Faccio un tiro di percezione',
    'faccio una prova di Atletica',
    'tento una prova di intuito',
    'provo un controllo di forza',
    // Social-skill verbs
    'persuado il mercante',
    'intimidisco la guardia',
    'inganno il guardiano',
    'convinco il sindaco a darmi la mappa',
  ])('returns true for: %s', (text) => {
    expect(isMechanicalIntent(text)).toBe(true);
  });
});

describe('isMechanicalIntent — English patterns', () => {
  it.each([
    'I roll perception',
    'I attack the orc',
    'I cast fireball',
    'I dodge',
    'I drink the potion',
    'I hide behind the pillar',
    'roll perception',
    'roll initiative',
    'attack the goblin',
    'short rest',
    'long rest',
    'saving throw on wisdom',
    'I inspect the seal',
    'I investigate the ancient inscription',
    'I study the runes',
    'I decipher the scroll',
    'I persuade the merchant',
    'I make a strength check',
    'I try a perception roll',
  ])('returns true for: %s', (text) => {
    expect(isMechanicalIntent(text)).toBe(true);
  });
});

describe('isMechanicalIntent — questions keep RAG on', () => {
  it.each([
    'come funziona il grapple?',
    'che bonus ha questa pozione?',
    'How does concentration work?',
    'tiro percezione, c\'è un bonus per la luce?',
    'attacco il goblin, posso usare il dardo magico come reazione?',
  ])('returns false for: %s', (text) => {
    expect(isMechanicalIntent(text)).toBe(false);
  });
});

describe('isMechanicalIntent — narrative / rules requests keep RAG on', () => {
  it.each([
    'Mi guardo intorno e descrivo cosa vedo nella sala del trono',
    'Voglio parlare con la sacerdotessa e capire chi è la divinità che venera',
    'Chiedo informazioni sul vecchio re al locandiere',
    'Provo a convincere il guardiano raccontandogli la storia di mia nonna',
    "Tell me about the temple's history",
    "I want to understand the curse that's affecting the village",
  ])('returns false for: %s', (text) => {
    expect(isMechanicalIntent(text)).toBe(false);
  });
});

describe('isMechanicalIntent — edge cases', () => {
  it('returns false for empty string', () => {
    expect(isMechanicalIntent('')).toBe(false);
  });

  it('returns false for whitespace only', () => {
    expect(isMechanicalIntent('   \n\t  ')).toBe(false);
  });

  it('trims leading whitespace before matching', () => {
    expect(isMechanicalIntent('   tiro percezione')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMechanicalIntent('TIRO PERCEZIONE')).toBe(true);
    expect(isMechanicalIntent('I ROLL PERCEPTION')).toBe(true);
  });
});
