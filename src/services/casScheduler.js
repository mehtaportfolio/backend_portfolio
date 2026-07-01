import cron from "node-cron";
import { generateCAS } from "./camsService.js";

export function initializeCASScheduler() {
    console.log("✅ [CAS Scheduler] Initialized");

    // PM - Every Saturday at 11:00 AM IST
    cron.schedule(
        "0 11 * * 6",
        async () => {
            console.log("========================================");
            console.log("[CAS Scheduler] Starting PM Weekly CAS");
            console.log("========================================");

            try {
                const result = await generateCAS({
                    email: process.env.EMAIL_PM,
                    password: process.env.PDF_PASSWORD
                });

                console.log("[CAS Scheduler] PM Result:", result);

            } catch (error) {
                console.error("[CAS Scheduler] PM Failed:", error.message);
            }

            console.log("========================================");
            console.log("[CAS Scheduler] PM Weekly CAS Finished");
            console.log("========================================");
        },
        {
            timezone: "Asia/Kolkata"
        }
    );

    // PSM - Every Saturday at 4:00 PM IST
    cron.schedule(
        "0 16 * * 6",
        async () => {
            console.log("========================================");
            console.log("[CAS Scheduler] Starting PSM Weekly CAS");
            console.log("========================================");

            try {
                const result = await generateCAS({
                    email: process.env.EMAIL_PSM,
                    password: process.env.PDF_PASSWORD
                });

                console.log("[CAS Scheduler] PSM Result:", result);

            } catch (error) {
                console.error("[CAS Scheduler] PSM Failed:", error.message);
            }

            console.log("========================================");
            console.log("[CAS Scheduler] PSM Weekly CAS Finished");
            console.log("========================================");
        },
        {
            timezone: "Asia/Kolkata"
        }
    );
}