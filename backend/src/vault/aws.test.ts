import { describe, expect, it, vi } from 'vitest';

// Fonctions pures : le runner (Docker) n'est jamais sollicité ici.
vi.mock('../runners/index.js', () => ({ runner: {} }));

const { checkPolicy, commandEnv, isReadOperation, parseInvocation, tokenize, validateRoleArn, validateRegion, validateStartUrl } = await import('./aws.js');

describe('aws : découpage des commandes', () => {
  it('découpe comme un shell, sans exécuter', () => {
    expect(tokenize(`s3 cp "mon fichier.txt" s3://b/k --metadata '{"a":"b c"}'`)).toEqual(['s3', 'cp', 'mon fichier.txt', 's3://b/k', '--metadata', '{"a":"b c"}']);
    expect(tokenize(`ec2 describe-instances --filters Name=tag:Env,Values=prod\\ ue`)).toEqual(['ec2', 'describe-instances', '--filters', 'Name=tag:Env,Values=prod ue']);
    expect(() => tokenize(`s3 ls "ouvert`)).toThrow(/guillemet/);
  });

  it('retire « aws » et repère le service et l’opération malgré les options globales', () => {
    expect(parseInvocation('aws --region eu-west-3 --output json s3api list-buckets')).toMatchObject({ service: 's3api', operation: 'list-buckets' });
    expect(parseInvocation('--output=table ec2 describe-instances')).toMatchObject({ service: 'ec2', operation: 'describe-instances' });
    expect(parseInvocation('help')).toMatchObject({ service: 'help', operation: null });
    expect(() => parseInvocation('  ')).toThrow(/Commande vide/);
  });
});

describe('aws : politique', () => {
  const item = { name: 'prod', readOnly: true, commandAllowlist: [] as string[] };

  it('reconnaît les lectures', () => {
    expect(isReadOperation('ec2', 'describe-instances')).toBe(true);
    expect(isReadOperation('s3', 'ls')).toBe(true);
    expect(isReadOperation('logs', 'tail')).toBe(true);
    expect(isReadOperation('sts', 'get-caller-identity')).toBe(true);
    expect(isReadOperation('dynamodb', 'query')).toBe(true);
    expect(isReadOperation('s3', 'cp')).toBe(false);
    expect(isReadOperation('ec2', 'run-instances')).toBe(false);
    expect(isReadOperation('sts', 'get-session-token')).toBe(false);
    expect(isReadOperation('ecr', 'get-login-password')).toBe(false);
    expect(isReadOperation('help', null)).toBe(true);
    expect(isReadOperation('s3', null)).toBe(false);
  });

  it('refuse les écritures en lecture seule, les accepte sinon', () => {
    expect(() => checkPolicy(parseInvocation('s3 rm s3://b/k'), item)).toThrow(/lecture seule/);
    expect(() => checkPolicy(parseInvocation('s3 ls s3://b'), item)).not.toThrow();
    expect(() => checkPolicy(parseInvocation('s3 rm s3://b/k'), { ...item, readOnly: false })).not.toThrow();
  });

  it('refuse toujours les profils locaux, le débogage et les commandes interactives', () => {
    expect(() => checkPolicy(parseInvocation('--profile admin s3 ls'), { ...item, readOnly: false })).toThrow(/--profile/);
    expect(() => checkPolicy(parseInvocation('s3 ls --debug'), item)).toThrow(/--debug/);
    expect(() => checkPolicy(parseInvocation('configure list'), { ...item, readOnly: false })).toThrow(/configure/);
    expect(() => checkPolicy(parseInvocation('sso login'), { ...item, readOnly: false })).toThrow(/sso/);
    expect(() => checkPolicy(parseInvocation('ssm start-session --target i-1'), { ...item, readOnly: false })).toThrow(/interactives/);
  });

  it('applique la liste blanche de préfixes', () => {
    const restricted = { ...item, readOnly: false, commandAllowlist: ['s3 ls', 'ec2 describe-instances'] };
    expect(() => checkPolicy(parseInvocation('aws s3 ls s3://b'), restricted)).not.toThrow();
    expect(() => checkPolicy(parseInvocation('ec2 describe-instances --output table'), restricted)).not.toThrow();
    expect(() => checkPolicy(parseInvocation('ec2 describe-volumes'), restricted)).toThrow(/politique/);
  });
});

describe('aws : réglages et environnement', () => {
  it('valide la région, le portail et le rôle', () => {
    expect(validateRegion(' EU-West-3 ')).toBe('eu-west-3');
    expect(() => validateRegion('paris')).toThrow(/région/);
    expect(validateStartUrl('https://mon-org.awsapps.com/start/#/')).toBe('https://mon-org.awsapps.com/start');
    expect(() => validateStartUrl('http://mon-org.awsapps.com/start')).toThrow(/https/);
    expect(validateRoleArn('arn:aws:iam::123456789012:role/agents')).toBe('arn:aws:iam::123456789012:role/agents');
    expect(() => validateRoleArn('agents')).toThrow(/ARN/);
  });

  it('ne met le jeton de session que s’il existe et désactive pager, invite et métadonnées', () => {
    const env = commandEnv({ accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: null, region: 'eu-west-3', expiresAt: null });
    expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's', AWS_DEFAULT_REGION: 'eu-west-3', AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', AWS_EC2_METADATA_DISABLED: 'true' });
    expect(env).not.toHaveProperty('AWS_SESSION_TOKEN');
    expect(commandEnv({ accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', region: 'eu-west-3', expiresAt: 1 }).AWS_SESSION_TOKEN).toBe('t');
  });
});
