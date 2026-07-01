import express from "express";
import { generateCAS } from "../services/camsService.js";

const router = express.Router();

router.post("/generate", async (req, res) => {
    try {
        const { account } = req.body;

        let email;

        switch (account) {
            case "PM":
                email = process.env.EMAIL_PM;
                break;

            case "PSM":
                email = process.env.EMAIL_PSM;
                break;

            default:
                return res.status(400).json({
                    success: false,
                    message: "Invalid account selected."
                });
        }

const password = process.env.PDF_PASSWORD;

console.log("Calling generateCAS...");

const result = await generateCAS({
    email,
    password
});

console.log("generateCAS returned:", result);

console.log("Sending response to frontend...");

return res.status(200).json(result);

    } catch (error) {
        console.error("CAMS Error:", error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


export default router;