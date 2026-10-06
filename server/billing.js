// Stripe subscriptions for the Plus plan. Disabled (everyone on Free) unless configured.
import Stripe from 'stripe';

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

export function createBilling(config, repo) {
  if (!config.billingEnabled) return { enabled: false };
  const stripe = new Stripe(config.stripe.secretKey);

  async function customerFor(user) {
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
    repo.setCustomer(user.id, customer.id);
    return customer.id;
  }

  return {
    enabled: true,

    async checkoutUrl(user) {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: await customerFor(user),
        client_reference_id: user.id,
        line_items: [{ price: config.stripe.priceId, quantity: 1 }],
        success_url: `${config.appUrl}/#/account?checkout=success`,
        cancel_url: `${config.appUrl}/#/account`,
      });
      return session.url;
    },

    async portalUrl(user) {
      if (!user.stripeCustomerId) return null;
      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${config.appUrl}/#/account`,
      });
      return session.url;
    },

    async cancelAll(user) {
      if (!user.stripeCustomerId) return;
      const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'all', limit: 20 });
      for (const sub of subs.data) {
        if (sub.status !== 'canceled') await stripe.subscriptions.cancel(sub.id);
      }
    },

    // Verifies the signature, then syncs the user's plan from the subscription state.
    async handleWebhook(rawBody, signature) {
      const event = stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
      if (event.type.startsWith('customer.subscription.')) {
        const sub = event.data.object;
        const user = repo.userByCustomer(sub.customer);
        if (user) {
          // Re-read the customer's subscriptions so out-of-order events can't downgrade a paying user.
          const subs = await stripe.subscriptions.list({ customer: sub.customer, status: 'all', limit: 20 });
          repo.setUserPlan(user.id, subs.data.some((s) => ACTIVE.has(s.status)) ? 'plus' : 'free');
        }
      }
      return event.type;
    },
  };
}
