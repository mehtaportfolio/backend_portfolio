import { EventEmitter } from 'events';
import { supabase } from '../db/supabaseClient.js';

class LogEmitter extends EventEmitter {
    log(message) {
        const timestamp = new Date().toLocaleTimeString();
        const formattedMessage = `[${timestamp}] ${message}`;
        console.log(formattedMessage);
        this.emit('log', formattedMessage);
    }

    /**
     * Logs the script execution details to the script_logs table
     */
    async logScriptRun(serviceName, status, errorDetails = null, runBy = 'system') {
        try {
            const { error } = await supabase
                .from('script_logs')
                .insert({
                    service_name: serviceName,
                    status: status,
                    error_details: errorDetails,
                    run_by: runBy
                });
            if (error) console.error(`Error logging script run for ${serviceName}:`, error);
        } catch (err) {
            console.error(`Unexpected error logging script run for ${serviceName}:`, err);
        }
    }
}

const logEmitter = new LogEmitter();
export default logEmitter;
