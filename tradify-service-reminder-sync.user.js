// ==UserScript==
// @name         Tradify Service Reminder Auto-Sync
// @namespace    https://github.com/ssp6/browser-code-scripts
// @version      2.2.0
// @description  Automatically create, update, and delete service reminders when Service Due Date is updated on jobs
// @author       MPH Data
// @match        https://go.tradifyhq.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/ssp6/browser-code-scripts/main/tradify-service-reminder-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/ssp6/browser-code-scripts/main/tradify-service-reminder-sync.user.js
// ==/UserScript==

// Visible here: https://github.com/ssp6/browser-code-scripts/blob/main/tradify-service-reminder-sync.user.js
(function() {
    'use strict';

    // ==================== CONSTANTS ====================
    const CONFIG = {
        BASE_URL: 'https://go.tradifyhq.com/api',
        CREATED_BY_USER_ID: '99724ead-3ce3-4457-9cdd-3f1ec120adbd',
        TENANT_ID: '00000000-0000-0000-0000-000000000000',
        DESCRIPTION: 'Automated creation',
        EMAIL_SEND_MODE: 1,  // 1 = Manual, 2 = Automatic
        EMAIL_TEMPLATE_ID: null,
        // Performance settings for slow connections/computers
        API_TIMEOUT: 30000,           // 30 seconds timeout
        MAX_RETRIES: 3,               // Retry failed requests 3 times
        RETRY_DELAY: 1000,            // Initial retry delay 1s
        SAVE_DEBOUNCE_DELAY: 2000,    // Wait 2s after last save before processing
        PAGE_STATE_DELAY: 1500,       // Wait 1.5s for page state to update
        AUTH_TOKEN_RETRY_DELAY: 500,  // Check for auth token every 500ms
        AUTH_TOKEN_MAX_WAIT: 10000,   // Wait max 10s for auth token
        LOADING_TIMEOUT: 30000,       // 30s timeout for initial job data load
        LOADING_CHECK_INTERVAL: 5000  // Check loading state every 5s
    };

    // ==================== STATE ====================
    let currentJobData = null;
    let currentButton = null;
    let saveDebounceTimer = null;
    let loadingStateTimer = null;
    let jobDataLoadStartTime = null;

    // ==================== LOGGING ====================
    
    function log(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const emoji = {
            info: 'ℹ️',
            success: '✅',
            error: '❌',
            warning: '⚠️',
            debug: '🔍'
        }[level] || 'ℹ️';
        
        const logFn = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
        logFn(`[ServiceReminder ${timestamp}] ${emoji} ${message}`);
    }

    // ==================== PAGE & URL HELPERS ====================
    
    function isOnJobPage() {
        const hash = window.location.hash;
        // Match /#/job/xxx but not /#/jobs (plural)
        return hash.includes('/job/') && !hash.includes('/jobs');
    }

    function getJobIdFromUrl() {
        const hash = window.location.hash;
        const match = hash.match(/\/job\/([^\/\?]+)/);
        return match ? match[1] : null;
    }

    function getServiceReminderUrl(reminderId) {
        return `https://go.tradifyhq.com/#/servicereminder/${reminderId}`;
    }

    function getServiceRemindersListUrl() {
        return 'https://go.tradifyhq.com/#/servicereminders/';
    }

    // ==================== UTILITY FUNCTIONS ====================
    
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    function formatTradifyDateTime(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
    }

    function formatDateToMidnight(dateString) {
        const date = new Date(dateString);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}/${month}/${day} 00:00:00`;
    }

    function validateServiceDate(dateString) {
        if (!dateString || dateString.trim() === '') {
            return { isValid: false, isPast: false, error: 'Date is empty' };
        }

        const date = new Date(dateString);
        if (isNaN(date.getTime())) {
            return { isValid: false, isPast: false, error: 'Invalid date format' };
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const serviceDate = new Date(date);
        serviceDate.setHours(0, 0, 0, 0);

        if (serviceDate < today) {
            return { isValid: false, isPast: true, error: 'Date is in the past' };
        }

        return { isValid: true, isPast: false, error: null };
    }

    function getAuthToken() {
        try {
            const stored = localStorage.getItem('requestVerificationToken');
            if (stored) {
                const parsed = JSON.parse(stored);
                return parsed.token;
            }
        } catch (e) {
            log('Failed to get auth token from localStorage', 'error');
        }
        return null;
    }

    async function waitForAuthToken() {
        const token = getAuthToken();
        if (token) {
            return token;
        }

        log('Auth token not available, waiting...', 'warning');
        
        const startTime = Date.now();
        while (Date.now() - startTime < CONFIG.AUTH_TOKEN_MAX_WAIT) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.AUTH_TOKEN_RETRY_DELAY));
            const token = getAuthToken();
            if (token) {
                log('Auth token acquired', 'success');
                return token;
            }
        }

        throw new Error('Auth token not available after waiting');
    }

    // ==================== UI - BUTTON STATES ====================
    
    function removeExistingButton() {
        if (currentButton) {
            currentButton.remove();
            currentButton = null;
        }
    }

    function createBaseButton(color, gradientEnd, text, href, icon = null) {
        removeExistingButton();

        const button = document.createElement('a');
        button.id = 'service-reminder-view-button';
        button.target = '_blank';
        button.href = href || getServiceRemindersListUrl();
        
        button.style.cssText = `
            position: fixed;
            top: 24px;
            right: 24px;
            padding: 14px 20px;
            background: linear-gradient(135deg, ${color} 0%, ${gradientEnd} 100%);
            color: white;
            border-radius: 12px;
            box-shadow: 0 4px 20px ${color}66;
            z-index: 9999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            font-weight: 600;
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 10px;
            transition: all 0.3s ease;
            cursor: pointer;
        `;

        // Calendar icon SVG
        const calendarIcon = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
        `;

        // External link icon SVG
        const externalIcon = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="7" y1="17" x2="17" y2="7"></line>
                <polyline points="7 7 17 7 17 17"></polyline>
            </svg>
        `;

        button.innerHTML = `${calendarIcon}<span>${text}</span>${externalIcon}`;

        // Hover effects
        button.addEventListener('mouseenter', () => {
            button.style.transform = 'translateY(-2px)';
            button.style.boxShadow = `0 6px 25px ${color}99`;
        });

        button.addEventListener('mouseleave', () => {
            button.style.transform = 'translateY(0)';
            button.style.boxShadow = `0 4px 20px ${color}66`;
        });

        document.body.appendChild(button);
        currentButton = button;
    }

    function showLoadingButton() {
        createBaseButton('#9CA3AF', '#6B7280', 'Plugin Loading...', null);
        jobDataLoadStartTime = Date.now();
        
        // Clear any existing timer
        if (loadingStateTimer) {
            clearTimeout(loadingStateTimer);
        }
        
        // Set up timeout to check loading state
        loadingStateTimer = setTimeout(checkLoadingTimeout, CONFIG.LOADING_TIMEOUT);
        
        // Periodic logging to show it's still waiting
        let checkCount = 0;
        const periodicCheck = setInterval(() => {
            checkCount++;
            if (!currentJobData && isOnJobPage()) {
                const elapsed = ((Date.now() - jobDataLoadStartTime) / 1000).toFixed(1);
                log(`Still waiting for job data... (${elapsed}s elapsed)`, 'info');
            } else {
                clearInterval(periodicCheck);
            }
        }, CONFIG.LOADING_CHECK_INTERVAL);
    }
    
    function checkLoadingTimeout() {
        if (!currentJobData && isOnJobPage()) {
            const elapsed = ((Date.now() - jobDataLoadStartTime) / 1000).toFixed(1);
            log(`Job data load timeout after ${elapsed}s - retrying...`, 'warning');
            
            // Try to manually fetch job data
            const jobId = getJobIdFromUrl();
            if (jobId) {
                log(`Attempting manual job data fetch for job ID: ${jobId}`, 'info');
                manuallyFetchJobData(jobId);
            } else {
                log('Cannot retry: no job ID found in URL', 'error');
                showNoReminderButton('Unknown');
            }
        }
    }

    function showCheckingButton(jobNumber) {
        const text = jobNumber ? `Job ${jobNumber}: Checking...` : 'Checking...';
        createBaseButton('#F59E0B', '#D97706', text, null);
    }

    function showReminderButton(reminder, jobNumber) {
        const dueDate = new Date(reminder.DueDate);
        const formattedDate = dueDate.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        });
        
        createBaseButton(
            '#667eea',
            '#764ba2',
            `Service: ${formattedDate}`,
            getServiceReminderUrl(reminder.Id)
        );
    }

    function showNoReminderButton(jobNumber) {
        const text = jobNumber ? `Job ${jobNumber}: No Reminder` : 'No Reminder';
        createBaseButton('#10b981', '#059669', text, getServiceRemindersListUrl());
    }

    function hideButton() {
        if (currentButton) {
            currentButton.style.transition = 'opacity 0.3s';
            currentButton.style.opacity = '0';
            setTimeout(() => {
                removeExistingButton();
            }, 300);
        }
    }

    // ==================== UI - NOTIFICATIONS ====================
    
    function showNotification(message, type = 'info', reminderUrl = null) {
        const existing = document.getElementById('service-reminder-notification');
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.id = 'service-reminder-notification';
        
        const bgColor = type === 'success' ? '#10B981' : type === 'error' ? '#EF4444' : '#3B82F6';
        
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 20px 24px;
            background: ${bgColor};
            color: white;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 10000;
            max-width: 400px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 15px;
            font-weight: 500;
            line-height: 1.5;
        `;

        let content = message;
        if (reminderUrl) {
            content += `<br><br><a href="${reminderUrl}" target="_blank" style="
                display: inline-block;
                margin-top: 8px;
                padding: 8px 16px;
                background: rgba(255, 255, 255, 0.2);
                color: white;
                text-decoration: none;
                border-radius: 4px;
                font-weight: 600;
                transition: background 0.2s;
            " onmouseover="this.style.background='rgba(255, 255, 255, 0.3)'"
               onmouseout="this.style.background='rgba(255, 255, 255, 0.2)'">
                View Service Reminder →
            </a>`;
        }

        notification.innerHTML = content;
        document.body.appendChild(notification);

        // Auto-remove after 10 seconds
        setTimeout(() => {
            notification.style.transition = 'opacity 0.3s';
            notification.style.opacity = '0';
            setTimeout(() => notification.remove(), 300);
        }, 10000);
    }

    // ==================== API - SERVICE REMINDER OPERATIONS ====================
    
    async function searchForReminder(jobId, jobNumber) {
        try {
            log(`Searching for reminder: Job ${jobNumber}`, 'info');

            const payload = {
                searchQuery: jobNumber || '',
                sort: { expression: 'dueDate', isAscending: true },
                page: { pageIndex: 1, pageSize: 100 },
                selectedIds: [],
                dateFrom: null,
                dateTo: null,
                serviceReminderListFilter: 1
            };

            const token = await waitForAuthToken();

            const response = await makeApiRequest(
                `${CONFIG.BASE_URL}/ServiceReminder/GetServiceReminderList`,
                'POST',
                payload,
                token
            );

            if (response?.Data && Array.isArray(response.Data)) {
                const reminder = response.Data.find(r => r.SourceJobId === jobId);
                if (reminder) {
                    log(`Found reminder: ${reminder.ServiceReminderNumber}`, 'success');
                    return reminder;
                } else {
                    log('No reminder found', 'info');
                    return null;
                }
            }

            return null;
        } catch (error) {
            log(`Search error: ${error.message}`, 'error');
            return null;
        }
    }

    async function createReminder(serviceDueDate) {
        try {
            log('Creating new reminder...', 'info');

            const newReminderId = generateUUID();
            const now = new Date();
            const dueDate = formatDateToMidnight(serviceDueDate);
            const createdOn = formatTradifyDateTime(now);

            const payload = {
                entities: [{
                    Id: newReminderId,
                    SourceJobId: currentJobData.Id,
                    CustomerId: currentJobData.CustomerId,
                    SiteId: null,
                    DueDate: dueDate,
                    Description: CONFIG.DESCRIPTION,
                    Status: 1,
                    CreatedOn: createdOn,
                    CreatedBy: CONFIG.CREATED_BY_USER_ID,
                    TenantId: CONFIG.TENANT_ID,
                    ServiceReminderNumber: "New Service Reminder",
                    ServiceReminderSequence: 0,
                    LastManualEmailSentOn: null,
                    LastAutomaticEmailSentOn: null,
                    ReminderEmailSendMode: CONFIG.EMAIL_SEND_MODE,
                    ReminderEmailTemplateId: CONFIG.EMAIL_TEMPLATE_ID,
                    entityAspect: {
                        entityTypeName: "ServiceReminder:#Tradify.Models",
                        defaultResourceName: "ServiceReminders",
                        entityState: "Added",
                        originalValuesMap: {},
                        autoGeneratedKey: null
                    }
                }],
                saveOptions: {}
            };

            const token = await waitForAuthToken();

            const response = await makeApiRequest(
                `${CONFIG.BASE_URL}/SaveChanges/SaveChanges`,
                'POST',
                payload,
                token
            );

            if (response?.Entities && response.Entities.length > 0) {
                const created = response.Entities[0];
                log(`Created reminder: ${created.ServiceReminderNumber}`, 'success');
                return created;
            }

            return null;
        } catch (error) {
            log(`Create error: ${error.message}`, 'error');
            throw error;
        }
    }

    async function updateReminder(existingReminder, serviceDueDate) {
        try {
            log('Updating reminder...', 'info');

            const dueDate = formatDateToMidnight(serviceDueDate);
            const originalDueDate = existingReminder.DueDate;

            const payload = {
                entities: [{
                    Id: existingReminder.Id,
                    SourceJobId: existingReminder.SourceJobId,
                    CustomerId: existingReminder.CustomerId,
                    SiteId: existingReminder.SiteId,
                    DueDate: dueDate,
                    Description: existingReminder.Description,
                    Status: existingReminder.Status,
                    CreatedOn: existingReminder.CreatedOn,
                    CreatedBy: existingReminder.CreatedBy,
                    TenantId: existingReminder.TenantId,
                    ServiceReminderNumber: existingReminder.ServiceReminderNumber,
                    ServiceReminderSequence: existingReminder.ServiceReminderSequence,
                    LastManualEmailSentOn: existingReminder.LastManualEmailSentOn,
                    LastAutomaticEmailSentOn: existingReminder.LastAutomaticEmailSentOn,
                    ReminderEmailSendMode: existingReminder.ReminderEmailSendMode,
                    ReminderEmailTemplateId: existingReminder.ReminderEmailTemplateId,
                    entityAspect: {
                        entityTypeName: "ServiceReminder:#Tradify.Models",
                        defaultResourceName: "ServiceReminders",
                        entityState: "Modified",
                        originalValuesMap: {
                            DueDate: originalDueDate
                        },
                        autoGeneratedKey: null
                    }
                }],
                saveOptions: {}
            };

            const token = await waitForAuthToken();

            const response = await makeApiRequest(
                `${CONFIG.BASE_URL}/SaveChanges/SaveChanges`,
                'POST',
                payload,
                token
            );

            if (response?.Entities && response.Entities.length > 0) {
                const updated = response.Entities[0];
                log(`Updated reminder: ${updated.ServiceReminderNumber}`, 'success');
                return updated;
            }

            return null;
        } catch (error) {
            log(`Update error: ${error.message}`, 'error');
            throw error;
        }
    }

    async function deleteReminder(existingReminder) {
        try {
            log('Deleting reminder...', 'info');

            const payload = {
                entities: [{
                    Id: existingReminder.Id,
                    SourceJobId: existingReminder.SourceJobId,
                    CustomerId: existingReminder.CustomerId,
                    SiteId: existingReminder.SiteId,
                    DueDate: existingReminder.DueDate,
                    Description: existingReminder.Description,
                    Status: existingReminder.Status,
                    CreatedOn: existingReminder.CreatedOn,
                    CreatedBy: existingReminder.CreatedBy,
                    TenantId: existingReminder.TenantId,
                    ServiceReminderNumber: existingReminder.ServiceReminderNumber,
                    ServiceReminderSequence: existingReminder.ServiceReminderSequence,
                    LastManualEmailSentOn: existingReminder.LastManualEmailSentOn,
                    LastAutomaticEmailSentOn: existingReminder.LastAutomaticEmailSentOn,
                    ReminderEmailSendMode: existingReminder.ReminderEmailSendMode,
                    ReminderEmailTemplateId: existingReminder.ReminderEmailTemplateId,
                    entityAspect: {
                        entityTypeName: "ServiceReminder:#Tradify.Models",
                        defaultResourceName: "ServiceReminders",
                        entityState: "Deleted",
                        originalValuesMap: {},
                        autoGeneratedKey: null
                    }
                }],
                saveOptions: {}
            };

            const token = await waitForAuthToken();

            await makeApiRequest(
                `${CONFIG.BASE_URL}/SaveChanges/SaveChanges`,
                'POST',
                payload,
                token
            );

            log(`Deleted reminder: ${existingReminder.ServiceReminderNumber}`, 'success');
            return true;
        } catch (error) {
            log(`Delete error: ${error.message}`, 'error');
            throw error;
        }
    }

    function makeApiRequest(url, method, payload, token, attempt = 1) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(method, url);
            xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
            xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
            xhr.setRequestHeader('clientapiversion', '69');
            xhr.setRequestHeader('requestverificationantiforgerytoken', token);

            // Set timeout
            xhr.timeout = CONFIG.API_TIMEOUT;

            xhr.onload = function() {
                if (xhr.status === 200) {
                    try {
                        resolve(JSON.parse(xhr.responseText));
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                } else {
                    reject(new Error(`HTTP ${xhr.status}`));
                }
            };

            xhr.onerror = () => reject(new Error('Network error'));
            
            xhr.ontimeout = () => reject(new Error('Request timeout'));

            // Send payload only for POST/PUT requests
            if (payload) {
                xhr.send(JSON.stringify(payload));
            } else {
                xhr.send();
            }
        }).catch(async (error) => {
            // Retry logic
            if (attempt < CONFIG.MAX_RETRIES) {
                const delay = CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1); // Exponential backoff
                log(`Request failed (attempt ${attempt}/${CONFIG.MAX_RETRIES}), retrying in ${delay}ms: ${error.message}`, 'warning');
                await new Promise(resolve => setTimeout(resolve, delay));
                return makeApiRequest(url, method, payload, token, attempt + 1);
            }
            throw error;
        });
    }

    // ==================== NAVIGATION HANDLING ====================
    
    function handleNavigationChange() {
        const jobId = getJobIdFromUrl();
        if (isOnJobPage()) {
            log(`Navigated to job page (ID: ${jobId})`, 'info');
            // Clear any existing timers
            if (loadingStateTimer) {
                clearTimeout(loadingStateTimer);
            }
            // Show loading and wait for job data
            showLoadingButton();
        } else {
            log('Left job page', 'info');
            hideButton();
            currentJobData = null;
            if (loadingStateTimer) {
                clearTimeout(loadingStateTimer);
                loadingStateTimer = null;
            }
        }
    }

    // ==================== JOB DATA HANDLING ====================
    
    async function manuallyFetchJobData(jobId) {
        try {
            log(`Manually fetching job data for ID: ${jobId}`, 'info');
            
            const token = await waitForAuthToken();
            const response = await makeApiRequest(
                `${CONFIG.BASE_URL}/Job/GetJobDetailData?id=${jobId}`,
                'GET',
                null,
                token
            );
            
            const jobData = response?.ChildData?.JobStaffMembers?.[0]?.Job;
            if (jobData) {
                log('Manual job data fetch successful', 'success');
                await handleJobDataLoaded(jobData);
            } else {
                log('Manual fetch returned no job data', 'error');
                showNoReminderButton('Unknown');
            }
        } catch (error) {
            log(`Manual fetch failed: ${error.message}`, 'error');
            showNoReminderButton('Error');
        }
    }
    
    async function handleJobDataLoaded(jobData) {
        // Clear loading timeout
        if (loadingStateTimer) {
            clearTimeout(loadingStateTimer);
            loadingStateTimer = null;
        }
        
        currentJobData = jobData;
        const jobNumber = jobData.JobNumber;
        const jobId = jobData.Id;
        
        const loadTime = jobDataLoadStartTime ? ((Date.now() - jobDataLoadStartTime) / 1000).toFixed(1) : 'N/A';
        log(`Job loaded: ${jobNumber} (took ${loadTime}s)`, 'success');

        // Only update button if still on a job page
        if (!isOnJobPage()) {
            return;
        }

        // Show checking state
        showCheckingButton(jobNumber);

        // Search for existing reminder
        const existingReminder = await searchForReminder(jobId, jobNumber);
        
        // Update button based on result
        if (existingReminder) {
            showReminderButton(existingReminder, jobNumber);
        } else {
            showNoReminderButton(jobNumber);
        }
    }

    // ==================== SAVE HANDLING ====================
    
    async function handleJobSave(serviceDueDate) {
        const jobNumber = currentJobData?.JobNumber || 'Unknown';
        const jobId = currentJobData?.Id;

        if (!jobId) {
            log('Cannot process save: No current job data', 'warning');
            return;
        }

        log(`Save detected: Custom4 ${serviceDueDate ? 'updated' : 'cleared'}`, 'info');

        // Search for existing reminder
        const existingReminder = await searchForReminder(jobId, jobNumber);

        // Longer delay to ensure page state is updated (especially on slow machines)
        await new Promise(resolve => setTimeout(resolve, CONFIG.PAGE_STATE_DELAY));

        try {
            if (serviceDueDate && serviceDueDate.trim() !== '') {
                // User set a date - validate it
                const validation = validateServiceDate(serviceDueDate);

                if (!validation.isValid) {
                    // Invalid date
                    showNotification(
                        `⚠️ Invalid Service Due Date<br><br>` +
                        `<strong>Job:</strong> ${jobNumber}<br>` +
                        `<strong>Date:</strong> ${serviceDueDate}<br>` +
                        `<strong>Reason:</strong> ${validation.error}<br><br>` +
                        `<em>Service reminder not ${existingReminder ? 'updated' : 'created'}</em>`,
                        'error'
                    );

                    // If there's an existing reminder for a now-invalid date, delete it
                    if (existingReminder) {
                        const deleted = await deleteReminder(existingReminder);
                        if (deleted) {
                            showNotification(
                                `🗑️ Existing Reminder Deleted<br><br>` +
                                `<strong>Job:</strong> ${jobNumber}<br>` +
                                `<strong>Number:</strong> ${existingReminder.ServiceReminderNumber}<br><br>` +
                                `<em>Date was ${validation.isPast ? 'in the past' : 'invalid'}</em>`,
                                'info'
                            );
                            showNoReminderButton(jobNumber);
                        }
                    }
                    return;
                }

                // Valid date - create or update
                if (existingReminder) {
                    const updated = await updateReminder(existingReminder, serviceDueDate);
                    if (updated) {
                        const reminderUrl = getServiceReminderUrl(updated.Id);
                        showNotification(
                            `✅ Service Reminder Updated<br><br>` +
                            `<strong>Job:</strong> ${jobNumber}<br>` +
                            `<strong>Date:</strong> ${serviceDueDate}<br>` +
                            `<strong>Number:</strong> ${updated.ServiceReminderNumber}`,
                            'success',
                            reminderUrl
                        );
                        showReminderButton(updated, jobNumber);
                    }
                } else {
                    const created = await createReminder(serviceDueDate);
                    if (created) {
                        const reminderUrl = getServiceReminderUrl(created.Id);
                        showNotification(
                            `✅ Service Reminder Created<br><br>` +
                            `<strong>Job:</strong> ${jobNumber}<br>` +
                            `<strong>Date:</strong> ${serviceDueDate}<br>` +
                            `<strong>Number:</strong> ${created.ServiceReminderNumber}`,
                            'success',
                            reminderUrl
                        );
                        showReminderButton(created, jobNumber);
                    }
                }
            } else {
                // Date cleared - delete if reminder exists
                if (existingReminder) {
                    const deleted = await deleteReminder(existingReminder);
                    if (deleted) {
                        showNotification(
                            `✅ Service Reminder Deleted<br><br>` +
                            `<strong>Job:</strong> ${jobNumber}<br>` +
                            `<strong>Number:</strong> ${existingReminder.ServiceReminderNumber}`,
                            'success'
                        );
                        showNoReminderButton(jobNumber);
                    }
                } else {
                    showNotification(
                        `ℹ️ Service Due Date Cleared<br><br>` +
                        `<strong>Job:</strong> ${jobNumber}<br><br>` +
                        `<em>No reminder to delete</em>`,
                        'info'
                    );
                }
            }
        } catch (error) {
            log(`Operation error: ${error.message}`, 'error');
            showNotification(
                `❌ Failed to sync reminder<br><br>` +
                `<strong>Job:</strong> ${jobNumber}<br>` +
                `<strong>Error:</strong> ${error.message}<br><br>` +
                `Check console for details`,
                'error'
            );
        }
    }

    // ==================== XHR INTERCEPTION ====================
    
    function setupXHRInterception() {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._url = url;
            this._method = method;
            return originalOpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.send = function(body) {
            const url = this._url;

            // Intercept: Job detail data loading
            if (url && url.includes('/Job/GetJobDetailData')) {
                log('Job detail data request detected', 'debug');
                
                this.addEventListener('load', async function() {
                    log(`Job detail data response received (status: ${this.status})`, 'debug');
                    try {
                        const data = JSON.parse(this.responseText);
                        const jobData = data?.ChildData?.JobStaffMembers?.[0]?.Job;
                        
                        if (jobData) {
                            await handleJobDataLoaded(jobData);
                        } else {
                            log('Job detail response had no job data', 'warning');
                        }
                    } catch (e) {
                        log(`Error parsing job data: ${e.message}`, 'error');
                    }
                });
                
                this.addEventListener('error', function() {
                    log('Job detail data request failed (network error)', 'error');
                });
                
                this.addEventListener('timeout', function() {
                    log('Job detail data request timed out', 'error');
                });
            }

            // Intercept: Job save with Custom4 (Service Due Date)
            if (url && url.includes('/SaveChanges/SaveChanges') && body) {
                try {
                    const requestData = JSON.parse(body);
                    const entity = requestData?.entities?.[0];

                    // Check if this is a Job save with Custom4 field
                    if (entity?.entityAspect?.entityTypeName === 'Job:#Tradify.Models' && 'Custom4' in entity) {
                        const serviceDueDate = entity.Custom4;

                        // Wait for save to complete, then process with debouncing
                        this.addEventListener('load', async function() {
                            // Clear any existing debounce timer
                            if (saveDebounceTimer) {
                                clearTimeout(saveDebounceTimer);
                                log('Debouncing rapid save...', 'info');
                            }

                            // Set new debounce timer
                            saveDebounceTimer = setTimeout(async () => {
                                try {
                                    await handleJobSave(serviceDueDate);
                                } catch (error) {
                                    log(`Save handling error: ${error.message}`, 'error');
                                    showNotification(
                                        `❌ Error processing save<br><br>Check console for details`,
                                        'error'
                                    );
                                }
                                saveDebounceTimer = null;
                            }, CONFIG.SAVE_DEBOUNCE_DELAY);
                        });
                    }
                } catch (e) {
                    log(`Error parsing save request: ${e.message}`, 'error');
                }
            }

            return originalSend.apply(this, arguments);
        };

        log('XHR interception active', 'success');
    }

    // ==================== DOM READY HELPER ====================
    
    function waitForDOM(callback) {
        if (document.body) {
            callback();
        } else if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', callback);
        } else {
            setTimeout(() => waitForDOM(callback), 50);
        }
    }

    // ==================== INITIALIZATION ====================
    
    function init() {
        log('Service Reminder Auto-Sync v2.2.0 (Enhanced logging & timeout handling)', 'info');

        // Set up XHR interception immediately (must be before any page loads)
        setupXHRInterception();

        // Set up navigation monitoring
        window.addEventListener('hashchange', handleNavigationChange);

        // Wait for DOM, then show initial button state
        waitForDOM(() => {
            if (isOnJobPage()) {
                showLoadingButton();
                log('On job page, waiting for job data...', 'info');
            }
            log('Ready and monitoring', 'success');
        });
    }

    // Start the script
    init();

})();

