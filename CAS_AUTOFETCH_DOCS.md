# Automated CAS Fetch (CAMS)

This feature enables automated generation of Consolidated Account Statements (CAS) from the CAMS website using Puppeteer.

## How it works

1.  **Initialization**: The user selects "Auto Request" in the CAS Import modal. This calls `/api/cas/auto-fetch/init`, which starts a headless browser, navigates to the CAMS CAS request page, and captures the captcha image.
2.  **User Input**: The captcha is displayed to the user in the frontend. The user enters the captcha text.
3.  **Submission**: The user submits the request. This calls `/api/cas/auto-fetch/submit` with the session ID, captcha value, and account details.
4.  **Automation**: The backend service fills the CAMS form using pre-configured credentials (Email, PAN) for the selected account, enters the captcha, and submits the form.
5.  **Mailback**: CAMS processes the request and sends the CAS statement PDF to the user's registered email address.
6.  **Next Steps**: Once the user receives the email, they can either use the "Gmail Import" feature to automatically fetch and process it, or manually download and upload the PDF.

## Environment Dependencies

The following environment variables must be configured in `.env.backend`:

-   `PDF_PASSWORD`: The password for the CAS PDF file (common for all accounts).
-   `PM_PAN`: PAN card number for the 'PM' account.
-   `EMAIL_PM`: Registered email for the 'PM' account.
-   `PSM_PAN`: PAN card number for the 'PSM' account.
-   `EMAIL_PSM`: Registered email for the 'PSM' account.

## Backend Service

-   `casFetchService.js`: Contains the Puppeteer logic for navigating CAMS and handling the multi-step session flow.
-   `cas.js` (Routes): Exposes the endpoints for initialization and submission.

## Frontend UI

-   `CASImportModal.js`: Includes a mode selector (Manual vs Auto) under the "CAMS" import method.
-   `mfAPI.js`: Contains the API methods for communicating with the auto-fetch endpoints.
