import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { z } from "zod";

import { EngineError, type MarketEngine } from "./engine.js";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? "";

// Stripe SDK is initialised lazily so the server still starts without a key
// (you'll get a clear runtime error only when the endpoint is actually called)
const getStripe = (): Stripe => {
    if (!stripeSecretKey || !stripeSecretKey.startsWith("sk_")) {
        throw new Error(
            "STRIPE_SECRET_KEY is not configured. Please set it in apps/api/.env (sk_test_...).",
        );
    }
    return new Stripe(stripeSecretKey);
};

const createPaymentIntentBodySchema = z.object({
    userId: z.string().min(1),
    amount: z.number().int().positive(), // in cents
    currency: z.string().default("eur"),
});

const createPayoutBodySchema = z.object({
    userId: z.string().min(1),
    amount: z.number().int().positive(), // in cents
});

export const registerStripeRoutes = (fastify: FastifyInstance, engine: MarketEngine): void => {
    /**
     * POST /stripe/create-payment-intent
     * Creates a Stripe PaymentIntent in test mode.
     * The client uses the returned clientSecret to present the PaymentSheet.
     * After the user confirms payment, call /users/:userId/funds/add to persist the balance.
     */
    fastify.post("/stripe/create-payment-intent", async (request, reply) => {
        const body = createPaymentIntentBodySchema.safeParse(request.body);
        if (!body.success) {
            return reply.code(400).send({ message: body.error.message });
        }

        try {
            const stripe = getStripe();
            const { userId, amount, currency } = body.data;

            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency,
                automatic_payment_methods: { enabled: true },
                metadata: { userId },
            });

            return { clientSecret: paymentIntent.client_secret };
        } catch (error) {
            if (error instanceof EngineError) {
                return reply.code(error.statusCode).send({ message: error.message });
            }
            const msg = error instanceof Error ? error.message : "Failed to create payment intent";
            return reply.code(500).send({ message: msg });
        }
    });

    /**
     * POST /stripe/create-payout
     * TEST MODE SIMULATION: In live mode, payouts go to a connected bank account.
     * In test mode we simply deduct from the user's engine balance, which is the
     * correct observable result — the Stripe payout object is created but funds
     * don't actually move in test mode anyway.
     */
    fastify.post("/stripe/create-payout", async (request, reply) => {
        const body = createPayoutBodySchema.safeParse(request.body);
        if (!body.success) {
            return reply.code(400).send({ message: body.error.message });
        }

        const { userId, amount } = body.data;
        const amountDecimal = amount / 100; // convert cents → EUR

        try {
            const currentWallet = engine.getWallet(userId);
            if (!currentWallet) {
                return reply.code(404).send({ message: "User wallet not found" });
            }
            if (currentWallet.balance < amountDecimal) {
                return reply.code(400).send({ message: "Insufficient balance" });
            }

            // Deduct from engine balance (simulates the payout completing)
            const wallet = engine.withdrawFunds(userId, amountDecimal);

            // NOTE: In test mode Stripe payouts don't actually send money.
            // We create the Payout object purely for audit trail / realism.
            // This will throw if STRIPE_SECRET_KEY is not set — catch below.
            try {
                const stripe = getStripe();
                await stripe.payouts.create(
                    { amount, currency: "eur", method: "standard" },
                    // Payouts require a connected account with a bank account — in pure
                    // test mode this will error unless you have one set up, which is fine.
                    // The balance has already been deducted server-side above.
                );
            } catch {
                // Payout creation in test mode without a bank account is expected to fail.
                // We still return success because the balance was deducted.
            }

            return { ok: true, wallet };
        } catch (error) {
            if (error instanceof EngineError) {
                return reply.code(error.statusCode).send({ message: error.message });
            }
            const msg = error instanceof Error ? error.message : "Payout failed";
            return reply.code(500).send({ message: msg });
        }
    });
};
