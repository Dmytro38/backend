require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

app.post('/process-payment', async (req, res) => {
    try {
        const { token, amount, currency = 'usd' } = req.body;

        // Create a customer
        const customer = await stripe.customers.create({
            source: token.id,
            email: token.email
        });

        // Create a charge
        const charge = await stripe.charges.create({
            amount: amount,
            currency: currency,
            customer: customer.id,
            description: 'Premium Plan Subscription',
            shipping: {
                name: token.card.name,
                address: {
                    line1: token.card.address_line1,
                    city: token.card.address_city,
                    state: token.card.address_state,
                    postal_code: token.card.address_zip
                }
            }
        });

        res.json({
            success: true,
            charge: charge
        });
    } catch (error) {
        console.error('Payment processing error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Create subscription with token
app.post('/create-subscription', async (req, res) => {
    try {
        const { token, plan, email } = req.body;

        // Create a customer
        const customer = await stripe.customers.create({
            email: email,
            source: token.id
        });

        // Create subscription
        const subscription = await stripe.subscriptions.create({
            customer: customer.id,
            items: [{ price: plan }],
            expand: ['latest_invoice.payment_intent']
        });

        res.json({
            success: true,
            subscription: subscription
        });
    } catch (error) {
        console.error('Subscription error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));