# 🚚 ZapShift — Server

This is the backend API for **ZapShift**, a full-stack parcel delivery management platform. It handles auth verification, parcel and rider data, payments, and delivery tracking for the client app.

- **Live API:** https://zap-shift-server-side-three.vercel.app
- **Client Repo/Site:** https://github.com/FahimFaysalNirjhar/zap-shift-client-side
- **Live Site:** https://zapshift-app.surge.sh

## 🛠️ Tech Stack

- **Node.js** + **Express**
- **MongoDB** (native driver, no ODM)
- **Firebase Admin SDK** — verifies ID tokens issued by the client's Firebase Auth
- **Stripe** — parcel payment checkout sessions
- Deployed as a **Vercel serverless function**

## 📡 API Overview

| Method | Route                           | Description                                                     |
| ------ | ------------------------------- | --------------------------------------------------------------- |
| GET    | `/parcels`                      | List parcels, filterable by `email` / `deliveryStatus`          |
| GET    | `/parcels/rider`                | List a rider's assigned parcels                                 |
| GET    | `/parcels/stats`                | Per-user parcel stats (auth required, self-only)                |
| GET    | `/parcels/deliver-status/stats` | Platform-wide parcel status breakdown (admin only)              |
| GET    | `/parcels/:id`                  | Get a single parcel                                             |
| POST   | `/parcels`                      | Create a parcel                                                 |
| PATCH  | `/parcels/:id`                  | Assign a rider to a parcel                                      |
| PATCH  | `/parcels/:id/status`           | Update delivery status                                          |
| DELETE | `/parcels/:id`                  | Delete a parcel                                                 |
| POST   | `/create-checkout-session`      | Create a Stripe checkout session                                |
| PATCH  | `/payment-success`              | Confirm payment, mark parcel paid, log tracking                 |
| GET    | `/payments`                     | List a user's payment history (auth required, self-only)        |
| GET    | `/riders`                       | List riders, filterable by `status` / `district` / `workStatus` |
| GET    | `/riders/stats`                 | Per-rider delivery & earnings stats (rider only, self-only)     |
| GET    | `/riders/status/stats`          | Platform-wide rider approval breakdown (admin only)             |
| GET    | `/riders/work-status/stats`     | Platform-wide rider availability breakdown (admin only)         |
| POST   | `/riders`                       | Submit a rider application                                      |
| PATCH  | `/riders/:riderId`              | Approve/update a rider                                          |
| DELETE | `/riders/:riderId`              | Remove a rider                                                  |
| GET    | `/trackings/:trackingId/logs`   | Public tracking history for a parcel                            |
| POST   | `/users`                        | Create a user record                                            |
| GET    | `/users`                        | List all users (auth required)                                  |
| GET    | `/users/:email/role`            | Get a user's role                                               |
| PATCH  | `/users/:userId/role`           | Change a user's role (admin only)                               |

## 🔐 Auth & Access Control

- `verifyFBToken` — validates the Firebase ID token sent in the `Authorization: Bearer <token>` header
- `verifyAdmin` — restricts a route to users with `role: "admin"`
- `verifyRider` — restricts a route to users with `role: "rider"`

Self-scoped routes (`/parcels/stats`, `/riders/stats`, `/payments`) additionally check that the requested `email` matches the token's decoded email, so users can only ever read their own data.

## ⚙️ Environment Variables

Create a `.env` file in the project root:

```
DB_USER=your_mongodb_username
DB_PASSWORD=your_mongodb_password
STRIPE_SECRET=your_stripe_secret_key
SITE_DOMAIN=http://localhost:5173
FB_SERVICE_KEY=your_base64_encoded_firebase_service_account_json
```

`FB_SERVICE_KEY` is your Firebase service account JSON, base64-encoded into a single line:

```bash
# Mac/Linux
base64 -i your-service-account.json | tr -d '\n'

# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("your-service-account.json"))
```

For deployment, add the same variables (with production values — e.g. `SITE_DOMAIN` set to your live frontend URL) in your hosting provider's environment variable settings, not just locally.

## 🚀 Getting Started Locally

```bash
npm install
node index.js
```

Server runs on `http://localhost:5000` by default (or `process.env.PORT` if set).

## ☁️ Deployment Notes (Vercel)

This app is structured to run as a Vercel serverless function:

- `module.exports = app` at the end of the entry file, so Vercel can invoke it as a handler
- `app.listen()` only runs when `NODE_ENV !== "production"`, since Vercel doesn't use a persistent listening process
- A `vercel.json` routes all requests into the entry file:

```json
{
  "version": 2,
  "builds": [{ "src": "index.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "index.js" }]
}
```

- The MongoDB connection is cached across warm invocations instead of reconnecting per request, since serverless functions don't behave like a long-running server.

## 👤 Author

**Fahim Faysal**
MERN Stack Developer

- GitHub: [FahimFaysalNirjhar](https://github.com/FahimFaysalNirjhar)
- LinkedIn: [Fahim Faysal](https://www.linkedin.com/in/fahim-faysal-a62b91153/)
