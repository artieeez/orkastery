"""Ingresso do Slack no canal Hermes. Gateway, Slack, CLI e credenciais exclusivamente SIMULADOS; sem rede."""
import asyncio
import enum
import hashlib
import hmac
import importlib.util
import json
import os
import time
from types import SimpleNamespace, ModuleType
import unittest
from unittest.mock import AsyncMock, patch
from layout import plugin_directory

spec = importlib.util.spec_from_file_location('ingress_slack', plugin_directory() / '__init__.py')
ingress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingress)

KEY = 'chave-SIMULADA-exclusiva-dos-testes-000'
TEAM, USER, CHANNEL, BOT = 'T0SIMULADO', 'U0SIMULADO', 'C0SIMULADO', 'U0BOTSIMULADO'


class MessageEvent(SimpleNamespace):
    pass


class Platform(enum.Enum):
    SLACK = 'slack'


def receipt(**changes):
    value = {'ok': True, 'pedidoId': 'pedido-1', 'estado': 'aprovado', 'repetida': False}
    value.update(changes)
    return SimpleNamespace(returncode=0, stdout=json.dumps(value))


class SlackIngressTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'ORK_HITL_INGRESS_KEY_HERMES': KEY,
            'ORK_HITL_SLACK_BOT_ID': BOT, 'ORK_HITL_SLACK_TEAM': TEAM, 'ORK_HITL_SLACK_USERS': USER,
            'ORK_HITL_SLACK_CHANNELS': CHANNEL, 'ORK_HITL_ROOT': '/tmp', 'ORK_BIN': 'ork-simulado'}, clear=True)
        self.env.start(); self.addCleanup(self.env.stop)
        base = ModuleType('gateway.platforms.base')
        base.MessageEvent = MessageEvent
        modules = patch.dict('sys.modules', {'gateway.platforms.base': base})
        modules.start(); self.addCleanup(modules.stop)
        self.ts = f'{time.time():.6f}'
        self.text = '/ork gate ork-simulado pedido-1 a'
        self.raw = {'type': 'message', 'user': USER, 'channel': CHANNEL, 'team': TEAM, 'ts': self.ts,
                    'text': f'<@{BOT}> {self.text}'}
        self.platform = Platform.SLACK
        self.source = SimpleNamespace(platform=self.platform, user_id=USER, chat_id=CHANNEL, scope_id=TEAM, is_bot=False)
        self.event = MessageEvent(text=self.text, raw_message=self.raw, message_id=self.ts, source=self.source)
        self.adapter = SimpleNamespace(send=AsyncMock(return_value=SimpleNamespace(success=True, message_id='1.2')))
        self.gateway = SimpleNamespace(_is_user_authorized=lambda _: True, adapters={self.platform: self.adapter})
        ingress._entries.clear()
        ingress._tasks.clear()

    def invoke(self):
        return ingress._ingress(event=self.event, gateway=self.gateway)

    async def finish(self):
        await asyncio.gather(*list(ingress._tasks))
        await asyncio.sleep(0)

    async def test_gate_assina_envelope_slack_e_confirma_na_thread(self):
        with patch.object(ingress.subprocess, 'run', return_value=receipt()) as run:
            self.assertEqual(self.invoke()['action'], 'skip')
            await self.finish()
        argv, kwargs = run.call_args.args[0], run.call_args.kwargs
        self.assertEqual(argv[:6], ['ork-simulado', 'gate', 'answer', 'ork-simulado', 'pedido-1', '--resposta-stdin'])
        self.assertIn('--origem', argv); self.assertEqual(argv[argv.index('--origem') + 1], 'slack')
        self.assertEqual(argv[argv.index('--canal') + 1], 'hermes')
        envelope = json.loads(kwargs['input'])
        self.assertEqual(envelope['origem'], 'slack')
        self.assertEqual(envelope['por'], f'slack:{TEAM}:{USER}')
        self.assertEqual(envelope['mensagem'], f'slack:{TEAM}:{CHANNEL}:{self.ts}')
        self.assertEqual(argv[argv.index('--por') + 1], envelope['por'])
        self.assertEqual(argv[argv.index('--mensagem') + 1], envelope['mensagem'])
        body = ['ork.hitl-answer/v2', 'ork-simulado', 'pedido-1', 'hermes', None, 'slack', envelope['por'],
                envelope['mensagem'], envelope['recebidoEm'], 'a']
        esperado = hmac.new(KEY.encode(), json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode(),
                            hashlib.sha256).hexdigest()
        self.assertEqual(envelope['prova'], esperado)
        self.adapter.send.assert_awaited_once()
        send = self.adapter.send.await_args
        self.assertEqual(send.args[:2], (CHANNEL, ingress.CONFIRM_TEXT['gate']))
        self.assertEqual(send.kwargs['reply_to'], self.ts)
        entry = next(iter(ingress._entries.values()))
        self.assertEqual((entry['effect'], entry['confirmation']), ('confirmed', 'sent'))
        # A mesma mensagem de novo e replay: nao chama o nucleo outra vez.
        with patch.object(ingress.subprocess, 'run') as run:
            self.assertTrue(self.invoke()['replay'])
            run.assert_not_called()

    async def test_pulse_responde_pelo_slack(self):
        self.text = self.event.text = 'P4EJ a'
        self.raw['text'] = 'P4EJ a'
        with patch.object(ingress.subprocess, 'run',
                          return_value=receipt(contrato='ork.pulse-resposta/v1', mensagem='registrado')) as run:
            self.assertEqual(self.invoke()['action'], 'skip')
            await self.finish()
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], ['ork-simulado', 'pulse', 'responder', '--resposta-stdin'])
        self.assertEqual(argv[argv.index('--origem') + 1], 'slack')
        self.assertEqual(self.adapter.send.await_args.args[1], 'registrado')

    async def test_recusas_nao_chamam_o_nucleo(self):
        casos = {
            'usuario fora da allowlist': lambda: (self.raw.update(user='U0INTRUSO'), setattr(self.source, 'user_id', 'U0INTRUSO')),
            'conversa fora da allowlist': lambda: (self.raw.update(channel='C0OUTRO'), setattr(self.source, 'chat_id', 'C0OUTRO')),
            'workspace errado': lambda: self.raw.update(team='T0OUTRO'),
            'mensagem editada': lambda: self.raw.update(subtype='message_changed'),
            'mensagem de bot': lambda: self.raw.update(bot_id='B0SIMULADO'),
            'fonte marcada como bot': lambda: setattr(self.source, 'is_bot', True),
            'o proprio bot': lambda: (self.raw.update(user=BOT), setattr(self.source, 'user_id', BOT)),
            'texto diverge do evento': lambda: self.raw.update(text='/ork gate ork-simulado pedido-1 b'),
            'mencao a outra pessoa': lambda: self.raw.update(text=f'<@U0OUTRA> {self.text}'),
            'mensagem velha': lambda: (self.raw.update(ts=f'{time.time() - 120:.6f}'),
                                       setattr(self.event, 'message_id', self.raw['ts'])),
            'id do evento diverge': lambda: setattr(self.event, 'message_id', '1.1'),
            'gateway nao autoriza': lambda: setattr(self.gateway, '_is_user_authorized', lambda _: False),
            'sem time configurado': lambda: os.environ.pop('ORK_HITL_SLACK_TEAM'),
            'chave curta': lambda: os.environ.update(ORK_HITL_INGRESS_KEY_HERMES='curta'),
        }
        for nome, estraga in casos.items():
            with self.subTest(nome):
                self.setUp()
                estraga()
                with patch.object(ingress.subprocess, 'run') as run:
                    result = self.invoke()
                    await self.finish()
                    self.assertEqual(result['action'], 'skip', nome)
                    run.assert_not_called()

    async def test_conversa_comum_segue_para_o_assistente(self):
        self.text = self.event.text = self.raw['text'] = 'bom dia'
        with patch.object(ingress.subprocess, 'run') as run:
            self.assertIsNone(self.invoke())
            run.assert_not_called()

    async def test_falha_no_envio_da_confirmacao_nao_vira_sucesso(self):
        self.adapter.send = AsyncMock(return_value=SimpleNamespace(success=False, message_id=None))
        with patch.object(ingress.subprocess, 'run', return_value=receipt()):
            self.invoke()
            await self.finish()
        entry = next(iter(ingress._entries.values()))
        self.assertEqual((entry['effect'], entry['confirmation']), ('confirmed', 'unknown'))


if __name__ == '__main__':
    unittest.main()
