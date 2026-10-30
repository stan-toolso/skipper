import { describe, expect, it } from 'vitest';
import { INTERRUPTED_LABEL, isEmptyNotificationResult, isInterruptedResult, resultError } from './claudeResult.js';

// Résultat réel émis par le CLI 2.1.300 après un clic sur « Interrompre » pendant un appel d'outil (24/10/2026).
const interrupted = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'],
  stop_reason: 'tool_use',
  terminal_reason: 'aborted_streaming',
};

describe('isInterruptedResult', () => {
  it('reconnaît une interruption pendant le modèle ou pendant les outils', () => {
    expect(isInterruptedResult(interrupted)).toBe(true);
    expect(isInterruptedResult({ ...interrupted, terminal_reason: 'aborted_tools' })).toBe(true);
  });

  it('ne confond pas une vraie erreur ou un tour complet avec une interruption', () => {
    expect(isInterruptedResult({ subtype: 'error_during_execution', is_error: true, errors: ['boom'], terminal_reason: 'api_error' })).toBe(false);
    expect(isInterruptedResult({ subtype: 'success', is_error: false, terminal_reason: 'completed' })).toBe(false);
    // Anciens CLI : pas de terminal_reason.
    expect(isInterruptedResult({ subtype: 'success', is_error: false })).toBe(false);
  });
});

describe('resultError', () => {
  it('un tour interrompu n’est pas une erreur de session, mais un échec lisible pour un agent ou une planification', () => {
    expect(resultError(interrupted, { interruptedIsError: false })).toBeNull();
    expect(resultError(interrupted)).toBe(INTERRUPTED_LABEL);
    expect(resultError(interrupted)).not.toContain('ede_diagnostic');
  });

  it('décrit une vraie erreur par son sous-type et ses messages', () => {
    expect(resultError({ subtype: 'error_during_execution', is_error: true, errors: ['boom', 'bang'] })).toBe('error_during_execution : boom ; bang');
    expect(resultError({ subtype: 'error_max_turns', is_error: true, errors: [] })).toBe('error_max_turns');
    // Erreur d'API : sous-type success, texte dans result.
    expect(resultError({ subtype: 'success', is_error: true, result: 'Overloaded' })).toBe('Overloaded');
  });

  it('un tour réussi n’a pas d’erreur', () => {
    expect(resultError({ subtype: 'success', is_error: false, result: 'Terminé', terminal_reason: 'completed' })).toBeNull();
  });
});

describe('isEmptyNotificationResult', () => {
  // Résultat réel émis par le CLI 2.1.314 à la reprise d'une session après un redémarrage (30/10/2026).
  const resumed = { type: 'result', subtype: 'success', is_error: false, result: '', num_turns: 0, duration_ms: 309, origin: { kind: 'task-notification' } };

  it('reconnaît le tour vide ouvert sur une notification de tâche de fond', () => {
    expect(isEmptyNotificationResult(resumed)).toBe(true);
  });

  it('ne concerne ni un tour normal ni un tour où le modèle a travaillé sur la notification', () => {
    expect(isEmptyNotificationResult({ subtype: 'success', num_turns: 0 })).toBe(false);
    expect(isEmptyNotificationResult({ subtype: 'success', num_turns: 5 })).toBe(false);
    expect(isEmptyNotificationResult({ ...resumed, num_turns: 2 })).toBe(false);
    expect(isEmptyNotificationResult({ ...resumed, origin: null })).toBe(false);
  });
});
