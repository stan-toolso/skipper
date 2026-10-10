import { describe, expect, it } from 'vitest';
import { evaluateCondition, ExpressionError, expressionPaths, parseExpression } from './expressions.js';

const ctx = { input: { env: 'prod', count: '3', flag: false }, nodes: { review: { json: { approved: true, score: 7, labels: ['bug', 'ui'] }, output: 'Looks good to me' } } };

describe('evaluateCondition', () => {
  it('compare souplement : nombres, texte, booléens', () => {
    expect(evaluateCondition('nodes.review.json.score >= 7', ctx)).toBe(true);
    expect(evaluateCondition('input.count == 3', ctx)).toBe(true);
    expect(evaluateCondition('nodes.review.json.approved == "true"', ctx)).toBe(true);
    expect(evaluateCondition('input.env != "prod"', ctx)).toBe(false);
  });
  it('gère and / or / not et les parenthèses', () => {
    expect(evaluateCondition('input.env == "prod" and nodes.review.json.approved', ctx)).toBe(true);
    expect(evaluateCondition('not input.flag && (input.env == "dev" || input.count > 2)', ctx)).toBe(true);
    expect(evaluateCondition('!nodes.review.json.approved or input.flag', ctx)).toBe(false);
  });
  it('texte : contains, startsWith, matches, in ; tableaux : contains / in', () => {
    expect(evaluateCondition('nodes.review.output contains "good"', ctx)).toBe(true);
    expect(evaluateCondition('nodes.review.output startsWith "looks"', ctx)).toBe(true);
    expect(evaluateCondition('nodes.review.output matches "^Looks.*me$"', ctx)).toBe(true);
    expect(evaluateCondition('nodes.review.json.labels contains "ui"', ctx)).toBe(true);
    expect(evaluateCondition('"bug" in nodes.review.json.labels', ctx)).toBe(true);
  });
  it('is empty / is not empty, et un chemin nu vaut par sa vérité', () => {
    expect(evaluateCondition('input.missing is empty', ctx)).toBe(true);
    expect(evaluateCondition('nodes.review.output is not empty', ctx)).toBe(true);
    expect(evaluateCondition('input.flag', ctx)).toBe(false);
    expect(evaluateCondition('input.env', ctx)).toBe(true);
  });
  it('refuse une expression invalide', () => {
    expect(() => parseExpression('')).toThrow(ExpressionError);
    expect(() => evaluateCondition('input.env ==', ctx)).toThrow(ExpressionError);
    expect(() => evaluateCondition('(input.env == "a"', ctx)).toThrow(ExpressionError);
  });
  it('liste les chemins référencés', () => {
    expect(expressionPaths('input.env == "prod" and nodes.review.json.approved')).toEqual(['input.env', 'nodes.review.json.approved']);
  });
});
