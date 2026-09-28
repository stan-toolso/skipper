import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Card, Form } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import { ANSWER_REQUEST, CANCEL_REQUEST, type HumanRequest } from '../graphql/operations';

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** Formulaire d'autorisation d'outil : autoriser (une fois / toujours) ou refuser avec un motif. */
function PermissionForm({ request, onAnswer, busy }: { request: HumanRequest; onAnswer: (r: Record<string, unknown>) => void; busy: boolean }) {
  const [message, setMessage] = useState('');
  const p = request.payload as { toolName?: string; input?: unknown; suggestions?: unknown[] };
  const canAlways = Array.isArray(p.suggestions) && p.suggestions.length > 0;
  return (
    <>
      <div className="small text-secondary mb-1">
        Outil <code>{String(p.toolName)}</code>
      </div>
      <pre className="bg-light p-2 rounded small mb-2" style={{ maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(p.input, null, 2)}
      </pre>
      <Form.Control size="sm" className="mb-2" placeholder="Motif ou consigne en cas de refus (optionnel)" value={message} onChange={(e) => setMessage(e.target.value)} />
      <div className="d-flex gap-2">
        <Button size="sm" variant="success" disabled={busy} onClick={() => onAnswer({ decision: 'allow' })}>
          Autoriser
        </Button>
        {canAlways && (
          <Button size="sm" variant="outline-success" disabled={busy} onClick={() => onAnswer({ decision: 'allow', always: true })}>
            Toujours autoriser (session)
          </Button>
        )}
        <Button size="sm" variant="outline-danger" disabled={busy} onClick={() => onAnswer({ decision: 'deny', message: message || undefined })}>
          Refuser
        </Button>
      </div>
    </>
  );
}

/** Formulaire de questions à choix (AskUserQuestion) avec possibilité de réponse libre. */
function QuestionForm({ request, onAnswer, busy }: { request: HumanRequest; onAnswer: (r: Record<string, unknown>) => void; busy: boolean }) {
  const questions = ((request.payload as { questions?: Question[] }).questions ?? []) as Question[];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (q: Question, label: string) =>
    setAnswers((prev) => {
      const current = prev[q.question] ?? [];
      if (!q.multiSelect) return { ...prev, [q.question]: [label] };
      return { ...prev, [q.question]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] };
    });

  const submit = () => {
    const result: Record<string, string> = {};
    for (const q of questions) {
      const selected = answers[q.question] ?? [];
      const free = other[q.question]?.trim();
      result[q.question] = [...selected, ...(free ? [free] : [])].join(', ');
    }
    onAnswer({ answers: result });
  };

  const complete = questions.every((q) => (answers[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());

  return (
    <>
      {questions.map((q) => (
        <div key={q.question} className="mb-3">
          <div className="fw-semibold">
            {q.header && <span className="badge bg-secondary me-2">{q.header}</span>}
            {q.question}
          </div>
          {q.options.map((o) => (
            <Form.Check
              key={o.label}
              type={q.multiSelect ? 'checkbox' : 'radio'}
              id={`${request.id}-${q.question}-${o.label}`}
              name={`${request.id}-${q.question}`}
              label={
                <>
                  {o.label}
                  {o.description && <span className="text-secondary small"> — {o.description}</span>}
                </>
              }
              checked={(answers[q.question] ?? []).includes(o.label)}
              onChange={() => toggle(q, o.label)}
            />
          ))}
          <Form.Control size="sm" className="mt-1" placeholder="Autre réponse (texte libre)" value={other[q.question] ?? ''} onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))} />
        </div>
      ))}
      <Button size="sm" disabled={busy || !complete} onClick={submit}>
        Répondre
      </Button>
    </>
  );
}

/** Formulaire générique : réponse texte libre. */
function InputForm({ onAnswer, busy }: { onAnswer: (r: Record<string, unknown>) => void; busy: boolean }) {
  const [text, setText] = useState('');
  return (
    <>
      <Form.Control as="textarea" rows={3} className="mb-2" value={text} onChange={(e) => setText(e.target.value)} />
      <Button size="sm" disabled={busy || !text.trim()} onClick={() => onAnswer({ text })}>
        Répondre
      </Button>
    </>
  );
}

const typeLabels: Record<string, string> = { permission: 'Autorisation', question: 'Question', input: 'Saisie' };

/** Carte d'une demande d'intervention humaine, avec le formulaire de réponse adapté à son type. */
export default function RequestCard({ request, showSession = false }: { request: HumanRequest; showSession?: boolean }) {
  const [answerRequest, { loading: answering, error: answerError }] = useMutation(ANSWER_REQUEST);
  const [cancelRequest, { loading: cancelling, error: cancelError }] = useMutation(CANCEL_REQUEST);
  const busy = answering || cancelling;
  const onAnswer = (response: Record<string, unknown>) => answerRequest({ variables: { id: request.id, response } });
  const error = answerError ?? cancelError;

  return (
    <Card className="mb-3 border-warning">
      <Card.Header className="d-flex justify-content-between align-items-center">
        <span>
          <span className="badge bg-warning text-dark me-2">{typeLabels[request.type] ?? request.type}</span>
          {request.title}
        </span>
        <span className="small text-secondary">
          {showSession && (
            <>
              <Link to={`/sessions/${request.session.id}`}>{request.session.name}</Link> · {request.session.project.name} ·{' '}
            </>
          )}
          {new Date(request.createdAt).toLocaleTimeString()}
        </span>
      </Card.Header>
      <Card.Body>
        {request.message && <p className="small">{request.message}</p>}
        {request.type === 'permission' && <PermissionForm request={request} onAnswer={onAnswer} busy={busy} />}
        {request.type === 'question' && <QuestionForm request={request} onAnswer={onAnswer} busy={busy} />}
        {request.type !== 'permission' && request.type !== 'question' && <InputForm onAnswer={onAnswer} busy={busy} />}
        {error && (
          <Alert variant="danger" className="mt-2 mb-0 py-1 small">
            {error.message}
          </Alert>
        )}
      </Card.Body>
      <Card.Footer className="text-end">
        <Button size="sm" variant="link" className="text-secondary" disabled={busy} onClick={() => cancelRequest({ variables: { id: request.id } })}>
          Abandonner la demande
        </Button>
      </Card.Footer>
    </Card>
  );
}
