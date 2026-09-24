CREATE TABLE IF NOT EXISTS "shopify_sessions" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "shop" varchar(255) NOT NULL,
  "state" varchar(255) NOT NULL,
  "isOnline" boolean NOT NULL,
  "scope" varchar(255),
  "expires" integer,
  "accessToken" varchar(255),
  "refreshToken" varchar(255),
  "refreshTokenExpires" bigint,
  "userId" bigint,
  "firstName" varchar(255),
  "lastName" varchar(255),
  "email" varchar(255),
  "accountOwner" boolean,
  "locale" varchar(255),
  "collaborator" boolean,
  "emailVerified" boolean
);
