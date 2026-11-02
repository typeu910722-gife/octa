"""OCTA × browser-use: a local Ollama model drives the bot's own browser.

The runner starts this with the bot's browser already open (CDP port). The model only ever sees the
current page (screenshot when it can see, otherwise the page's element list) and picks one action at a
time through Ollama's native structured tool calls, which small local models handle far better than a
long general-purpose agent prompt.

usage: python octa-browseruse.py --task FILE --out FILE --cdp URL --model NAME
         [--ctx N] [--steps N] [--vision 0|1] [--host URL]
Prints "OCTA_STEP <n> <what>" lines for progress; writes the final report (UTF-8) to --out.
"""
import argparse
import asyncio
import os
import sys

os.environ.setdefault('ANONYMIZED_TELEMETRY', 'false')
os.environ.setdefault('BROWSER_USE_SETUP_LOGGING', 'false')

EXTRA = (
	'用繁體中文寫最後的報告。完成或卡住時呼叫 done，報告照任務要求的格式寫。'
	'看到登入頁且沒有帳密可用時，不要亂猜帳密，直接 done 並寫「需要使用者在電腦上登入」。'
	'不要關掉使用者原本開著的分頁。'
)


def say(*parts):
	print('OCTA_STEP', *parts, flush=True)


async def main():
	ap = argparse.ArgumentParser()
	ap.add_argument('--task', required=True)
	ap.add_argument('--out', required=True)
	ap.add_argument('--cdp', required=True)
	ap.add_argument('--model', required=True)
	ap.add_argument('--host', default='http://127.0.0.1:11434')
	ap.add_argument('--ctx', type=int, default=24576)
	ap.add_argument('--steps', type=int, default=25)
	ap.add_argument('--vision', type=int, default=0)
	a = ap.parse_args()

	from browser_use import Agent, Browser, ChatOllama

	with open(a.task, encoding='utf-8') as f:
		task = f.read()
	llm = ChatOllama(model=a.model, host=a.host, timeout=300, ollama_options={'num_ctx': a.ctx})
	# keep_alive: the browser belongs to the bot (logins, open tabs) — never close it when done
	browser = Browser(cdp_url=a.cdp, keep_alive=True)

	def on_step(state, output, n):
		try:
			acts = [next(iter(x.model_dump(exclude_none=True)), '') for x in (output.action or [])]
		except Exception:
			acts = []
		url = getattr(state, 'url', '') or ''
		say(n, ','.join(a for a in acts if a) or 'think', url[:120])

	agent = Agent(
		task=task, llm=llm, browser=browser,
		use_vision=bool(a.vision), max_actions_per_step=3, max_failures=3,
		extend_system_message=EXTRA, register_new_step_callback=on_step,
		llm_timeout=300, step_timeout=420,
		use_judge=False,   # an extra full call to the same small model after every run: slow and adds nothing here
	)
	text = ''
	try:
		history = await agent.run(max_steps=a.steps)
		text = (history.final_result() or '').strip()
		if not text:
			errs = [e for e in (history.errors() or []) if e]
			last = (history.urls() or [''])[-1] or ''
			text = '瀏覽沒有完成（步數用完或模型沒有回報）。\n卡在哪裡：' + (errs[-1][:300] if errs else '模型沒有呼叫 done') + ('\n網址：' + last if last else '')
	finally:
		try:
			await browser.stop()   # with keep_alive this only disconnects
		except Exception:
			pass
	with open(a.out, 'w', encoding='utf-8') as f:
		f.write(text)
	print(text, flush=True)


if __name__ == '__main__':
	try:
		asyncio.run(main())
	except Exception as e:
		print('error: ' + (str(e) or type(e).__name__)[:800], file=sys.stderr, flush=True)
		sys.exit(1)
