"""
ai_monitor.py
Phase 5 — Configurable QA Monitor + Notifications
-----------------------------------------------
Loads config.json, runs Phase 4 (ai_insight_engine) with thresholds,
and sends Slack / Email notifications automatically.
"""

import os, json, smtplib, ssl, requests
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from ai_insight_engine import main as run_insight_engine

CONFIG_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "config.json"))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
RESULTS = os.path.join(ROOT, "results")

def load_config():
    if not os.path.exists(CONFIG_PATH):
        raise FileNotFoundError("config.json missing — create one in project root")
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def send_slack_message(webhook_url, text):
    try:
        resp = requests.post(webhook_url, json={"text": text})
        print("Slack notification:", resp.status_code)
    except Exception as e:
        print("Slack notification failed:", e)

def send_email(cfg, subject, body):
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = cfg["username"]
        msg["To"] = ", ".join(cfg["to"])
        msg.attach(MIMEText(body, "plain"))

        context = ssl.create_default_context()
        with smtplib.SMTP(cfg["smtp_server"], cfg["smtp_port"]) as server:
            server.starttls(context=context)
            server.login(cfg["username"], cfg["password"])
            server.send_message(msg)
        print("Email sent successfully ✅")
    except Exception as e:
        print("Email notification failed:", e)

def summarize_payload(payload):
    txt = f"📢 AI QA Monitor Report — Run {payload['run_folder']}\n"
    txt += f"Detected Performance Anomalies: {len(payload['performance_anomalies'].get('per_page',[]))} | "
    txt += f"Visual Anomalies: {len(payload.get('visual_anomalies',[]))}\n\n"
    txt += payload["summary"]["text"][:900] + "..."
    return txt

def main():
    cfg = load_config()
    payload = run_insight_engine(auto_inject=cfg["report"]["inject_into_html"],
                                 auto_regen_pdf=cfg["report"]["regenerate_pdf"])
    msg_text = summarize_payload(payload)

    if cfg["notifications"]["enable_slack"]:
        send_slack_message(cfg["notifications"]["slack_webhook_url"], msg_text)

    if cfg["notifications"]["enable_email"]:
        email_cfg = cfg["notifications"]["email"]
        send_email(email_cfg, f"AI QA Report — {payload['run_folder']}", msg_text)

    print("\n✅ Please check your inbox.")

if __name__ == "__main__":
    main()
