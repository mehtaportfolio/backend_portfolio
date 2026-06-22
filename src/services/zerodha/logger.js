/**
 * Logger utility for Zerodha Service
 */
const logger = {
    info: (message, data = {}) => {
        const timestamp = new Date().toISOString();
        console.log(`[ZERODHA-INFO] [${timestamp}] ${message}`, Object.keys(data).length ? data : '');
    },
    error: (message, error = {}) => {
        const timestamp = new Date().toISOString();
        console.error(`[ZERODHA-ERROR] [${timestamp}] ${message}`, error);
    },
    warn: (message, data = {}) => {
        const timestamp = new Date().toISOString();
        console.warn(`[ZERODHA-WARN] [${timestamp}] ${message}`, Object.keys(data).length ? data : '');
    },
    debug: (message, data = {}) => {
        if (process.env.NODE_ENV !== 'production') {
            const timestamp = new Date().toISOString();
            console.log(`[ZERODHA-DEBUG] [${timestamp}] ${message}`, Object.keys(data).length ? data : '');
        }
    }
};

export default logger;
