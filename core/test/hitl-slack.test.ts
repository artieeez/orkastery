/** Slack como segundo transporte assinado do canal Hermes. Nenhuma identidade aqui e real: tudo e SIMULADO. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  abrirPedidoGate, assinaturaDaResposta, canalDoEnvelope, responderGate, RespostaHumana,
} from '../src/hitl-gates';
import { validarEvidenciaDoIngresso } from '../src/hitl-ingress-receipt';
import { ENV_HITL_VERIFIERS, publicHitlVerifiers } from '../src/hitl-public-receipt';
import {
  autorDoTransporteValido, canalAtendePor, conferirRegistro, CONTRATO_CANAIS, ofertaDeCanais,
  provenienciaDoTransporte, transportesDoCanal,
} from '../src/hitl-canais';
import { conversaDoCanal } from '../src/pulse-resposta';
import { canalValido } from '../src/transporte-do-canal';
import { dirThread, novaThread } from '../src/thread';
import { lerLedger, registrar } from '../src/ledger';
import { projetoTemporario } from './apoio';

const quando = '2026-09-16T01:00:00.000Z';
const CHAVE_HERMES = 'chave-SIMULADA-exclusiva-do-canal-hermes-0000';
const CHAVE_OPENCLAW = 'chave-SIMULADA-exclusiva-do-canal-openclaw-00';
const TIME = 'T0SIMULADO', USUARIO = 'U0SIMULADO', CANAL = 'C0SIMULADO';
const slackEnv = {
  ORK_HITL_SLACK_TEAM: TIME, ORK_HITL_SLACK_USERS: USUARIO, ORK_HITL_SLACK_CHANNELS: CANAL,
} as NodeJS.ProcessEnv;

function ambiente() {
  const valores: Record<string, string> = {
    ORK_HITL_INGRESS_KEY_HERMES: CHAVE_HERMES, ORK_HITL_INGRESS_KEY_OPENCLAW: CHAVE_OPENCLAW,
    ORK_HITL_OPENCLAW_ACCOUNT: 'conta-SIMULADA', ORK_HITL_TELEGRAM_USERS: '42', ORK_HITL_TELEGRAM_CHATS: '-7',
    ORK_HITL_SLACK_TEAM: TIME, ORK_HITL_SLACK_USERS: USUARIO, ORK_HITL_SLACK_CHANNELS: CANAL,
  };
  const antigos = Object.keys(valores).map(n => [n, process.env[n]] as const);
  Object.assign(process.env, valores);
  return () => antigos.forEach(([n, v]) => { if (v === undefined) delete process.env[n]; else process.env[n] = v; });
}

function envelopeSlack(thread: string, pedido: string, alteracao: Partial<RespostaHumana> = {},
  chave = CHAVE_HERMES): RespostaHumana {
  const r = { resposta: '1', origem: 'slack' as const, canal: 'hermes' as const, por: `slack:${TIME}:${USUARIO}`,
    mensagem: `slack:${TIME}:${CANAL}:1726448400.000100`, recebidoEm: quando, ...alteracao };
  return { ...r, prova: assinaturaDaResposta(thread, pedido, r, chave) };
}

function gatePronto(p: ReturnType<typeof projetoTemporario>, nome: string) {
  const { thread: t } = novaThread(p.carregado, { nome, modo: 'classic' });
  registrar(dirThread(p.dir, t.id), t.id, 'phase_result', { fase: 'GOAL', evidencia: 'fixture simulada' });
  return { t, pedido: abrirPedidoGate(p.dir, t.id, undefined, quando) };
}

test('Slack: so o canal Hermes atende por slack, e o registro continua conferindo', () => {
  assert.deepEqual([...transportesDoCanal('hermes')], ['telegram', 'slack']);
  assert.deepEqual([...transportesDoCanal('openclaw')], ['telegram']);
  assert.equal(canalAtendePor('hermes', 'slack'), true);
  assert.equal(canalAtendePor('openclaw', 'slack'), false);
  // O envelope v1 (sem canal) so existiu no Telegram.
  assert.equal(canalAtendePor(null, 'slack'), false);
  assert.equal(canalAtendePor(null, 'telegram'), true);
  assert.deepEqual(conferirRegistro(), { contrato: CONTRATO_CANAIS, canais: 4, transportes: 3, chaves: 2 });
});

test('Slack: o envelope declara canal e transporte que o registro aceita', () => {
  assert.equal(canalDoEnvelope({ canal: 'hermes', origem: 'slack' }), 'hermes');
  assert.throws(() => canalDoEnvelope({ canal: 'openclaw', origem: 'slack' }), /transporte-divergente/);
  assert.throws(() => canalDoEnvelope({ canal: undefined, origem: 'slack' }), /transporte-divergente/);
  assert.throws(() => canalDoEnvelope({ canal: 'codex', origem: 'slack' }), /transporte-divergente/);
});

test('Slack: proveniencia exige o workspace, a pessoa e a conversa das allowlists', () => {
  const por = `slack:${TIME}:${USUARIO}`, msg = `slack:${TIME}:${CANAL}:1726448400.000100`;
  assert.equal(provenienciaDoTransporte('slack', por, msg, slackEnv), true);
  assert.equal(autorDoTransporteValido('slack', por), true);
  assert.equal(autorDoTransporteValido('telegram', por), false);
  // Pessoa, conversa e workspace fora das allowlists.
  assert.equal(provenienciaDoTransporte('slack', `slack:${TIME}:U0OUTRA`, msg, slackEnv), false);
  assert.equal(provenienciaDoTransporte('slack', por, `slack:${TIME}:C0OUTRO:1726448400.000100`, slackEnv), false);
  assert.equal(provenienciaDoTransporte('slack', `slack:T0OUTRO:${USUARIO}`, `slack:T0OUTRO:${CANAL}:1.1`, slackEnv), false);
  // Workspace diferente entre pessoa e mensagem, mesmo com o time certo num dos lados.
  assert.equal(provenienciaDoTransporte('slack', por, `slack:T0OUTRO:${CANAL}:1.1`, slackEnv), false);
  // Sem time configurado nada passa; formas do Telegram nao valem como Slack nem o contrario.
  assert.equal(provenienciaDoTransporte('slack', por, msg, { ...slackEnv, ORK_HITL_SLACK_TEAM: '' }), false);
  assert.equal(provenienciaDoTransporte('slack', 'telegram:42', 'telegram:-7:1', slackEnv), false);
  assert.equal(provenienciaDoTransporte('telegram', por, msg,
    { ORK_HITL_TELEGRAM_USERS: '42', ORK_HITL_TELEGRAM_CHATS: '-7' }), false);
  // Formas invalidas do ts e dos ids.
  assert.equal(provenienciaDoTransporte('slack', por, `slack:${TIME}:${CANAL}:abc`, slackEnv), false);
  assert.equal(provenienciaDoTransporte('slack', `slack:${TIME}:u0minusculo`, msg, slackEnv), false);
});

test('Slack: a oferta deixa o Hermes disponivel so pelo Slack, e diz o que falta', () => {
  const base = { ORK_HITL_ROOT: '/tmp/ork-SIMULADO', ORK_HITL_INGRESS_KEY_HERMES: CHAVE_HERMES,
    ORK_HITL_SLACK_BOT_ID: 'U0BOTSIMULADO', ORK_HITL_SLACK_TEAM: TIME, ORK_HITL_SLACK_USERS: USUARIO,
    ORK_HITL_SLACK_CHANNELS: CANAL };
  const hermes = ofertaDeCanais({ env: base }).find(o => o.canal === 'hermes')!;
  assert.deepEqual(hermes, { canal: 'hermes', transporte: 'slack', estado: 'disponivel', motivo: '' });
  const semTime = ofertaDeCanais({ env: { ...base, ORK_HITL_SLACK_TEAM: '' } }).find(o => o.canal === 'hermes')!;
  assert.equal(semTime.estado, 'indisponivel');
  // Sem nenhum transporte provisionado, o motivo e o do principal (Telegram), como antes.
  assert.match(semTime.motivo, /ORK_HITL_TELEGRAM_BOT_ID/);
  const idsInvalidos = ofertaDeCanais({ env: { ...base, ORK_HITL_SLACK_CHANNELS: 'geral' } }).find(o => o.canal === 'hermes')!;
  assert.equal(idsInvalidos.estado, 'indisponivel');
  // O OpenClaw nao ganha o Slack.
  assert.equal(ofertaDeCanais({ env: base }).find(o => o.canal === 'openclaw')!.estado, 'indisponivel');
});

test('Slack: destino do pulse e conversa da resposta', () => {
  assert.equal(canalValido({ host: 'hermes', destino: `slack:${CANAL}` }), true);
  assert.equal(canalValido({ host: 'hermes', destino: `slack:${CANAL}:1726448400.000100` }), true);
  assert.equal(canalValido({ host: 'openclaw', destino: `slack:${CANAL}` }), false);
  assert.equal(canalValido({ host: 'hermes', destino: 'slack:#geral' }), false);
  assert.equal(conversaDoCanal(`slack:${TIME}:${CANAL}:1726448400.000100`), `slack:${CANAL}`);
  assert.equal(conversaDoCanal(`slack:${CANAL}:1726448400.000100`), `slack:${CANAL}`);
  assert.equal(conversaDoCanal(`slack:${CANAL}`), `slack:${CANAL}`);
  assert.equal(conversaDoCanal('telegram:-7:1'), '-7');
  assert.notEqual(conversaDoCanal(`slack:${CANAL}`), conversaDoCanal('telegram:-7'));
});

test('Slack: gate aprovado pelo Slack grava recibo do canal Hermes que reconfere', () => {
  const p = projetoTemporario('slack-gate'), restaurar = ambiente();
  try {
    const { t, pedido } = gatePronto(p, 'gate slack');
    assert.equal(responderGate(p.dir, t.id, pedido.id, envelopeSlack(t.id, pedido.id), quando).estado, 'aprovado');
    const e = lerLedger(dirThread(p.dir, t.id)).find(x => x.tipo === 'human_gate')!;
    assert.equal(e.origem, 'slack');
    assert.equal(e.canal, 'hermes');
    assert.equal(e.autorizadoPor, `slack:${TIME}:${USUARIO}`);
    assert.equal(e.contratoResposta, 'ork.hitl-answer/v2');
    assert.equal(validarEvidenciaDoIngresso(p.dir, String(t.id), e), true);
    // Origem trocada no ledger depois de gravado reprova a reconferencia.
    assert.equal(validarEvidenciaDoIngresso(p.dir, String(t.id), { ...e, origem: 'telegram' }), false);
    assert.equal(validarEvidenciaDoIngresso(p.dir, String(t.id), { ...e, autorizadoPor: 'telegram:42' }), false);
    // O agente sem a chave: so os verificadores publicos (o slot do canal cobre os dois transportes).
    const publicos = publicHitlVerifiers()!;
    const chave = process.env.ORK_HITL_INGRESS_KEY_HERMES;
    delete process.env.ORK_HITL_INGRESS_KEY_HERMES;
    process.env[ENV_HITL_VERIFIERS] = publicos;
    try {
      assert.equal(validarEvidenciaDoIngresso(p.dir, String(t.id), e), true);
      assert.equal(validarEvidenciaDoIngresso(p.dir, String(t.id), { ...e, origem: 'telegram' }), false);
    } finally { process.env.ORK_HITL_INGRESS_KEY_HERMES = chave; delete process.env[ENV_HITL_VERIFIERS]; }
  } finally { restaurar(); p.limpar(); }
});

test('Slack: recusas antes de qualquer efeito', () => {
  const p = projetoTemporario('slack-recusas'), restaurar = ambiente();
  try {
    const { t, pedido } = gatePronto(p, 'gate slack recusas');
    const casos: Array<[RespostaHumana, RegExp]> = [
      // Pessoa fora da allowlist, conversa fora, workspace errado.
      [envelopeSlack(t.id, pedido.id, { por: `slack:${TIME}:U0INTRUSO`, mensagem: `slack:${TIME}:${CANAL}:1.1` }), /proveniência/],
      [envelopeSlack(t.id, pedido.id, { mensagem: `slack:${TIME}:C0OUTRO:1.2` }), /proveniência/],
      [envelopeSlack(t.id, pedido.id, { por: `slack:T0OUTRO:${USUARIO}`, mensagem: `slack:T0OUTRO:${CANAL}:1.3` }), /proveniência/],
      // Slack pelo OpenClaw ou sem canal (v1) nao existe.
      [envelopeSlack(t.id, pedido.id, { canal: 'openclaw', mensagem: `slack:${TIME}:${CANAL}:1.4` }, CHAVE_OPENCLAW), /transporte-divergente/],
      [envelopeSlack(t.id, pedido.id, { canal: undefined, mensagem: `slack:${TIME}:${CANAL}:1.5` }), /transporte-divergente/],
      // Assinado com a chave de outro canal.
      [envelopeSlack(t.id, pedido.id, { mensagem: `slack:${TIME}:${CANAL}:1.6` }, CHAVE_OPENCLAW), /não autenticada/],
    ];
    for (const [r, erro] of casos) assert.throws(() => responderGate(p.dir, t.id, pedido.id, r, quando), erro);
    // Um envelope do Telegram assinado e reapresentado como Slack: a origem esta no corpo assinado.
    const tg = { resposta: '1', origem: 'telegram' as const, canal: 'hermes' as const, por: 'telegram:42',
      mensagem: 'telegram:-7:9', recebidoEm: quando };
    const assinado = { ...tg, prova: assinaturaDaResposta(t.id, pedido.id, tg, CHAVE_HERMES) };
    assert.throws(() => responderGate(p.dir, t.id, pedido.id, {
      ...assinado, origem: 'slack', por: `slack:${TIME}:${USUARIO}`, mensagem: `slack:${TIME}:${CANAL}:1.7` }, quando),
    /não autenticada/);
    assert.equal(lerLedger(dirThread(p.dir, t.id)).filter(e => e.tipo === 'human_gate').length, 0);
  } finally { restaurar(); p.limpar(); }
});
