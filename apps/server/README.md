# Backend API

## Public

- `GET /health`
- `GET /api`

## Authentication

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `POST /api/auth/change-password`
- `GET /api/me`

## Rooms and wallet

- `GET /api/rooms`
- `POST /api/rooms`
- `POST /api/rooms/:code/join`
- `GET /api/wallet/transactions`

## Admin

- `GET /api/admin/users`
- `POST /api/admin/wallet/:userId`

All mutating endpoints validate server-side authorization. Socket events require a JWT access token in `auth.token`.
