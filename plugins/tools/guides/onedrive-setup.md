---
title: OneDrive Setup Guide
form_step: enter-your-credentials
---

## Register an Azure App

Before Stallari can access your OneDrive files, you need to register an application in Azure Active Directory. This gives Stallari permission to use the Microsoft Graph API on your behalf.

1. Open the [Azure App Registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) page in your browser
2. Sign in with your Microsoft account (the same account that owns the OneDrive you want to connect)
3. Click **New registration**
4. Fill in the registration form:
   - **Name**: `Stallari OneDrive` (or any name you prefer)
   - **Supported account types**: Select **Accounts in this organizational directory only** (single tenant)
   - **Redirect URI**: Select **Mobile and desktop applications** from the dropdown, then enter: `https://login.microsoftonline.com/common/oauth2/nativeclient`
5. Click **Register**

> **Tip:** You'll be taken to the app's overview page. Keep this tab open — you'll need values from it in later steps.

## Configure API Permissions

Your newly registered app needs permission to access OneDrive files via the Microsoft Graph API.

1. In your app's page, click **API permissions** in the left sidebar
2. Click **Add a permission**
3. Select **Microsoft Graph**
4. Select **Delegated permissions**
5. Search for and enable these permissions:
   - `Files.ReadWrite.All` — read and write all files the user can access
   - `Sites.ReadWrite.All` — access SharePoint sites (needed for shared drives)
6. Click **Add permissions**
7. Click **Grant admin consent** if you have admin rights (otherwise, ask your tenant admin)

> **Note:** If you only need read access, you can use `Files.Read.All` and `Sites.Read.All` instead. You can always add write permissions later.

## Copy Your Credentials

Now collect the two values you'll need to connect Stallari:

1. Go back to the **Overview** page of your app registration
2. Copy the **Application (client) ID** — this is your **Client ID**
3. Copy the **Directory (tenant) ID** — this is your **Tenant ID**

> **Tip:** Both values are UUIDs in the format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. You'll find them near the top of the Overview page.

### Client Secret (optional)

A client secret is only needed if you want to run Stallari in headless mode (without interactive sign-in). For normal use with device code flow, skip this step.

If you need a secret:
1. Click **Certificates & secrets** in the left sidebar
2. Click **New client secret**
3. Set a description and expiry, then click **Add**
4. Copy the secret **Value** immediately — it won't be shown again

## Enter Your Credentials

Paste the values you copied from the Azure portal into the fields below.

The default auth mode is **device code** — on first connection, Stallari will display a code and ask you to visit `microsoft.com/devicelogin` to complete sign-in. This only happens once; the token is cached for subsequent use.
