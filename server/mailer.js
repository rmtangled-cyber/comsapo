// Sends login links. Uses Resend when configured; otherwise prints to the console (dev only).
export function createMailer(config) {
  if (!config.mail.resendApiKey) {
    return {
      async sendLoginLink(email, url) {
        console.log(`[mail:dev] login link for ${email}: ${url}`);
      },
    };
  }
  return {
    async sendLoginLink(email, url) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: config.mail.from,
          to: [email],
          subject: 'comsapo ログインリンク',
          text: `comsapo にログインするには、15分以内に次のリンクを開いてください。\n\n${url}\n\nこのメールに心当たりがない場合は破棄してください。`,
        }),
      });
      if (!res.ok) throw new Error(`mail send failed: ${res.status} ${await res.text()}`);
    },
  };
}
