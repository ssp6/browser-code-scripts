// ==UserScript==
// @name         Tradify Service Reminder Auto-Sync
// @namespace    https://github.com/ssp6/browser-code-scripts
// @version      1.4.0
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

    // ==================== CONFIGURATION ====================
    const BASE_URL = 'https://go.tradifyhq.com/api';
    const CREATED_BY_USER_ID = '99724ead-3ce3-4457-9cdd-3f1ec120adbd';
    const TENANT_ID = '00000000-0000-0000-0000-000000000000';
    const DESCRIPTION = 'Automated creation';
    
    // Email settings (use manual mode, no template)
    const EMAIL_SEND_MODE = 1;  // 1 = Manual, 2 = Automatic
    const EMAIL_TEMPLATE_ID = null;
    
    // ==================== STATE ====================
    let currentJobData = null;
    let antiForgeryToken = null;  // Get from localStorage
    let currentReminderButton = null;  // Reference to floating button
    let scriptHealthy = true;  // Track script health
    let lastTokenCheck = null;  // Track when we last got the token

    // ==================== UTILITY FUNCTIONS ====================

    /**
     * Check if we're currently on a job page
     * @returns {string|null} - Job ID if on job page, null otherwise
     */
    function getJobIdFromUrl() {
        const match = window.location.hash.match(/#\/job\/([a-f0-9-]+)/i);
        return match ? match[1] : null;
    }

    /**
     * Get anti-forgery token from localStorage
     * @returns {string|null} - The token or null if not found
     */
    function getAntiForgeryToken() {
        try {
            const tokenData = localStorage.getItem('requestVerificationToken');
            if (tokenData) {
                const parsed = JSON.parse(tokenData);
                if (parsed && parsed.token) {
                    lastTokenCheck = new Date();
                    return parsed.token;
                }
            }
            console.warn('[ServiceReminder] ⚠️ Token not found in localStorage');
            return null;
        } catch (error) {
            console.error('[ServiceReminder] ❌ Error reading token from localStorage:', error);
            return null;
        }
    }

    /**
     * Log with timestamp for better debugging
     */
    function log(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const emoji = {
            'info': 'ℹ️',
            'success': '✅',
            'warning': '⚠️',
            'error': '❌',
            'debug': '🔍'
        }[level] || 'ℹ️';
        
        const logFn = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
        logFn(`[ServiceReminder ${timestamp}] ${emoji} ${message}`);
    }

    /**
     * Generate a UUID v4
     */
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Format date to Tradify's format: "YYYY/MM/DD HH:mm:ss"
     */
    function formatTradifyDateTime(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
    }

    /**
     * Format date to midnight in Tradify format
     */
    function formatDateToMidnight(dateString) {
        const date = new Date(dateString);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}/${month}/${day} 00:00:00`;
    }

    /**
     * Validate if a date string is valid and not in the past
     * @param {string} dateString - The date string to validate
     * @returns {object} - { isValid: boolean, isPast: boolean, error: string }
     */
    function validateServiceDate(dateString) {
        // Check if date string is provided
        if (!dateString || dateString.trim() === '') {
            return { isValid: false, isPast: false, error: 'Date is empty' };
        }

        // Try to parse the date
        const date = new Date(dateString);
        
        // Check if date is valid
        if (isNaN(date.getTime())) {
            return { isValid: false, isPast: false, error: 'Invalid date format' };
        }

        // Check if date is in the past (compare to today at midnight)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const serviceDate = new Date(date);
        serviceDate.setHours(0, 0, 0, 0);
        
        if (serviceDate < today) {
            return { isValid: false, isPast: true, error: 'Date is in the past' };
        }

        return { isValid: true, isPast: false, error: null };
    }

    /**
     * Get service reminder URL
     */
    function getServiceReminderUrl(reminderId) {
        return `https://go.tradifyhq.com/#/servicereminder/${reminderId}`;
    }

    // ==================== UI NOTIFICATIONS ====================

    /**
     * Show a floating status button - either for viewing reminder or accessing service reminders page
     * @param {object} reminder - The service reminder object (or null if none exists)
     * @param {string} jobNumber - The current job number
     */
    function showStatusButton(reminder, jobNumber) {
        // Remove existing button if any
        if (currentReminderButton) {
            currentReminderButton.remove();
            currentReminderButton = null;
        }

        // Determine button properties based on whether reminder exists
        const hasReminder = reminder !== null && reminder !== undefined;
        const url = hasReminder 
            ? getServiceReminderUrl(reminder.Id)
            : 'https://go.tradifyhq.com/#/servicereminders';
        
        const backgroundColor = hasReminder 
            ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
            : 'linear-gradient(135deg, #10B981 0%, #059669 100%)';
        
        const shadowColor = hasReminder 
            ? 'rgba(102, 126, 234, 0.4)'
            : 'rgba(16, 185, 129, 0.4)';

        // Create floating button
        const button = document.createElement('a');
        button.id = 'service-reminder-view-button';
        button.href = url;
        button.target = '_blank';
        button.style.cssText = `
            position: fixed;
            top: 24px;
            right: 24px;
            padding: 14px 20px;
            background: ${backgroundColor};
            color: white;
            border-radius: 12px;
            box-shadow: 0 4px 20px ${shadowColor};
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

        let buttonContent;
        if (hasReminder) {
            // Format due date for display
            const dueDate = new Date(reminder.DueDate);
            const formattedDate = dueDate.toLocaleDateString('en-US', { 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
            });

            buttonContent = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="16" y1="2" x2="16" y2="6"></line>
                    <line x1="8" y1="2" x2="8" y2="6"></line>
                    <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                <span>Service Reminder: ${formattedDate}</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="7" y1="17" x2="17" y2="7"></line>
                    <polyline points="7 7 17 7 17 17"></polyline>
                </svg>
            `;
        } else {
            buttonContent = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="16" y1="2" x2="16" y2="6"></line>
                    <line x1="8" y1="2" x2="8" y2="6"></line>
                    <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                <span>Service Reminders (${jobNumber || 'Job'})</span>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="7" y1="17" x2="17" y2="7"></line>
                    <polyline points="7 7 17 7 17 17"></polyline>
                </svg>
            `;
        }

        button.innerHTML = buttonContent;

        // Add hover effect
        const hoverShadow = hasReminder 
            ? '0 6px 25px rgba(102, 126, 234, 0.5)'
            : '0 6px 25px rgba(16, 185, 129, 0.5)';

        button.addEventListener('mouseenter', () => {
            button.style.transform = 'translateY(-2px)';
            button.style.boxShadow = hoverShadow;
        });

        button.addEventListener('mouseleave', () => {
            button.style.transform = 'translateY(0)';
            button.style.boxShadow = `0 4px 20px ${shadowColor}`;
        });

        // Add title tooltip
        button.title = hasReminder 
            ? `Click to view service reminder for ${jobNumber || 'this job'}`
            : `No service reminder set. Click to view all service reminders.`;

        document.body.appendChild(button);
        currentReminderButton = button;
        
        log(`Status button shown: ${hasReminder ? 'Reminder exists' : 'No reminder'}`, 'debug');
    }

    /**
     * Legacy function - now redirects to showStatusButton
     * @param {object} reminder - The service reminder object
     */
    function showReminderButton(reminder) {
        const jobNumber = getJobNumber();
        showStatusButton(reminder, jobNumber);
    }

    /**
     * Hide the floating reminder button
     */
    function hideReminderButton() {
        if (currentReminderButton) {
            currentReminderButton.style.transition = 'opacity 0.3s';
            currentReminderButton.style.opacity = '0';
            setTimeout(() => {
                if (currentReminderButton) {
                    currentReminderButton.remove();
                    currentReminderButton = null;
                }
            }, 300);
        }
    }

    /**
     * Show generic button immediately on job page
     * Will be updated once GetJobDetailData completes
     */
    function showGenericButtonForJobPage() {
        const jobId = getJobIdFromUrl();
        if (!jobId) {
            log('Not on a job page, skipping button', 'debug');
            return;
        }

        log(`On job page (ID: ${jobId}), showing generic button (will update when job data loads)`, 'info');
        
        // Show green button linking to service reminders page
        // This will be updated to purple/specific once we get job data
        showStatusButton(null, 'Job');
        
        // Set a timeout to fetch job data manually if we don't intercept the API call
        // This handles cases where the page loaded before our XHR interception started
        setTimeout(() => {
            if (!currentJobData || currentJobData.Id !== jobId) {
                log('GetJobDetailData not intercepted, fetching job data manually...', 'info');
                fetchJobDataManually(jobId);
            }
        }, 2000);
    }
    
    /**
     * Manually fetch job data if we missed the automatic interception
     */
    async function fetchJobDataManually(jobId) {
        try {
            antiForgeryToken = getAntiForgeryToken();
            if (!antiForgeryToken) {
                log('Cannot fetch job data: No token available', 'warning');
                return;
            }
            
            const payload = {
                jobId: jobId,
                childDataQueryParams: {
                    jobId: jobId,
                    jobNotesQueryParams: {
                        sort: { expression: 'createdOn', isAscending: true },
                        page: { pageIndex: 1, pageSize: 25 },
                        selectedIds: [],
                        jobId: jobId,
                        retrieveAll: false
                    },
                    formsQueryParams: {
                        sort: { expression: 'createdOn', isAscending: true },
                        page: { pageIndex: 1, pageSize: 25 },
                        selectedIds: [],
                        jobId: jobId,
                        retrieveAll: false
                    },
                    scheduleItemsQueryParams: {
                        sort: { expression: 'startTime', isAscending: false },
                        page: { pageIndex: 1, pageSize: 25 },
                        selectedIds: [],
                        jobId: jobId,
                        retrieveAll: false
                    },
                    invoicesQueryParams: {
                        searchQuery: null,
                        sort: { expression: 'invoiceSequence', isAscending: true },
                        page: { pageIndex: 1, pageSize: 25 },
                        selectedIds: [],
                        jobId: jobId,
                        retrieveAll: false
                    },
                    estimatesQueryParams: {
                        searchQuery: null,
                        sort: { expression: 'estimateSequence', isAscending: true },
                        page: { pageIndex: 1, pageSize: 25 },
                        selectedIds: [],
                        jobId: jobId,
                        retrieveAll: false
                    },
                    purchaseOrdersQueryParams: {
                        searchQuery: null,
                        sort: { expression: 'purchaseOrderSequence', isAscending: true },
                        page: { pageIndex: 1, pageSize: 25 },
                        selectedIds: [],
                        jobId: jobId,
                        retrieveAll: false
                    },
                    supplierInvoicesQueryParams: {
                        searchQuery: null,
                        sort: { expression: 'createdOn', isAscending: true },
                        page: { pageIndex: 1, pageSize: 25 },
                        selectedIds: [],
                        jobId: jobId,
                        retrieveAll: false
                    },
                    jobServiceReportsQueryParams: {
                        sort: { expression: 'createdOn', isAscending: true },
                        page: { pageIndex: 1, pageSize: 25 },
                        selectedIds: [],
                        jobId: jobId,
                        retrieveAll: false
                    }
                }
            };
            
            log('Manual API Call: Fetching job detail data...', 'debug');
            
            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/Job/GetJobDetailData`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            log(`Failed to parse manual API response: ${e.message}`, 'error');
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        log(`Manual API call failed: HTTP ${xhr.status}`, 'error');
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => {
                    log('Network error during manual job data fetch', 'error');
                    reject(new Error('Network error'));
                };
                
                xhr.send(JSON.stringify(payload));
            });
            
            if (response?.ChildData?.JobStaffMembers?.[0]?.Job) {
                currentJobData = response.ChildData.JobStaffMembers[0].Job;
                const jobNumber = currentJobData.JobNumber;
                
                log(`Job data fetched manually: ${jobNumber} (ID: ${jobId})`, 'success');
                
                // Search for existing reminder and update button
                const existingReminder = await findServiceReminderByJob(jobId);
                showStatusButton(existingReminder, jobNumber);
            } else {
                log('Unexpected response format from manual job fetch', 'warning');
            }
        } catch (error) {
            log(`Manual fetch error: ${error.message}`, 'error');
        }
    }

    /**
     * Show a notification popup with optional link
     */
    function showNotification(message, type = 'info', reminderUrl = null) {
        
        // Remove any existing notification
        const existing = document.getElementById('service-reminder-notification');
        if (existing) existing.remove();
        
        // Create notification element
        const notification = document.createElement('div');
        notification.id = 'service-reminder-notification';
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 20px 24px;
            background: ${type === 'success' ? '#10B981' : type === 'error' ? '#EF4444' : '#3B82F6'};
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
        
        // Auto-remove after 10 seconds (longer since we have a link)
        setTimeout(() => {
            notification.style.transition = 'opacity 0.3s';
            notification.style.opacity = '0';
            setTimeout(() => notification.remove(), 300);
        }, 10000);
    }

    // ==================== JOB DATA HELPERS ====================

    /**
     * Get current job number from stored data
     */
    function getJobNumber() {
        if (currentJobData && currentJobData.JobNumber) {
            return currentJobData.JobNumber;
        }
        return null;
    }

    /**
     * Get current job ID from stored data
     */
    function getJobId() {
        if (currentJobData && currentJobData.Id) {
            return currentJobData.Id;
        }
        return null;
    }

    // ==================== SERVICE REMINDER OPERATIONS ====================

    /**
     * Search for existing service reminder by job ID
     * @param {string} jobId - The job ID to search for
     * @returns {Promise<object|null>} - The service reminder if found, null otherwise
     */
    async function findServiceReminderByJob(jobId) {
        try {
            log('Searching for existing reminder...', 'debug');
            
            // Get fresh token from localStorage
            antiForgeryToken = getAntiForgeryToken();
            if (!antiForgeryToken) {
                log('Cannot search for reminder: No anti-forgery token available', 'error');
                scriptHealthy = false;
                return null;
            }
            
            const jobNumber = getJobNumber();
            if (!jobNumber) {
                log('Cannot search: Job number not available yet (need GetJobDetailData to complete first)', 'warning');
                return null;
            }
            
            const payload = {
                searchQuery: jobNumber,
                sort: { expression: 'dueDate', isAscending: true },
                page: { pageIndex: 1, pageSize: 100 },
                selectedIds: [],
                dateFrom: null,
                dateTo: null,
                serviceReminderListFilter: 1
            };

            log(`API Call: Searching reminders for job ${jobNumber} (ID: ${jobId})`, 'debug');

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/ServiceReminder/GetServiceReminderList`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            log(`Failed to parse API response: ${e.message}`, 'error');
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        log(`API search failed: HTTP ${xhr.status} - ${xhr.responseText}`, 'error');
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => {
                    log('Network error during reminder search', 'error');
                    reject(new Error('Network error'));
                };
                
                xhr.send(JSON.stringify(payload));
            });

            if (response?.Data && Array.isArray(response.Data)) {
                const reminder = response.Data.find(r => r.SourceJobId === jobId);
                
                if (reminder) {
                    log(`Found existing reminder: ${reminder.ServiceReminderNumber} (Due: ${reminder.DueDate})`, 'success');
                    return reminder;
                } else {
                    log('No existing reminder found for this job', 'info');
                    return null;
                }
            }
            
            log('Unexpected API response format', 'warning');
            return null;
        } catch (error) {
            log(`Search error: ${error.message}`, 'error');
            scriptHealthy = false;
            return null;
        }
    }

    /**
     * Create a new service reminder
     * @param {string} serviceDueDate - The service due date string
     * @returns {Promise<object|null>} - The created reminder or null on failure
     */
    async function createServiceReminder(serviceDueDate) {
        try {
            log('Creating new reminder...', 'info');
            
            // Get fresh token from localStorage
            antiForgeryToken = getAntiForgeryToken();
            if (!antiForgeryToken) {
                log('Cannot create reminder: No anti-forgery token available', 'error');
                scriptHealthy = false;
                throw new Error('No anti-forgery token');
            }
            
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
                    Description: DESCRIPTION,
                    Status: 1,
                    CreatedOn: createdOn,
                    CreatedBy: CREATED_BY_USER_ID,
                    TenantId: TENANT_ID,
                    ServiceReminderNumber: "New Service Reminder",
                    ServiceReminderSequence: 0,
                    LastManualEmailSentOn: null,
                    LastAutomaticEmailSentOn: null,
                    ReminderEmailSendMode: EMAIL_SEND_MODE,
                    ReminderEmailTemplateId: EMAIL_TEMPLATE_ID,
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

            log(`API Call: Creating reminder for job ${getJobNumber()} with due date ${dueDate}`, 'debug');

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/SaveChanges/SaveChanges`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            log(`Failed to parse create response: ${e.message}`, 'error');
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        log(`API create failed: HTTP ${xhr.status} - ${xhr.responseText}`, 'error');
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => {
                    log('Network error during reminder creation', 'error');
                    reject(new Error('Network error'));
                };
                
                xhr.send(JSON.stringify(payload));
            });

            if (response?.Entities && response.Entities.length > 0) {
                const created = response.Entities[0];
                log(`Created successfully: ${created.ServiceReminderNumber}`, 'success');
                return created;
            }
            
            log('Unexpected create response format', 'warning');
            return null;
        } catch (error) {
            log(`Create error: ${error.message}`, 'error');
            scriptHealthy = false;
            throw error;
        }
    }

    /**
     * Update an existing service reminder
     * @param {object} existingReminder - The existing reminder object
     * @param {string} serviceDueDate - The new service due date string
     * @returns {Promise<object|null>} - The updated reminder or null on failure
     */
    async function updateServiceReminder(existingReminder, serviceDueDate) {
        try {
            log('Updating existing reminder...', 'info');
            
            // Get fresh token from localStorage
            antiForgeryToken = getAntiForgeryToken();
            if (!antiForgeryToken) {
                log('Cannot update reminder: No anti-forgery token available', 'error');
                scriptHealthy = false;
                throw new Error('No anti-forgery token');
            }
            
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

            log(`API Call: Updating reminder ${existingReminder.ServiceReminderNumber} from ${originalDueDate} to ${dueDate}`, 'debug');

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/SaveChanges/SaveChanges`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            log(`Failed to parse update response: ${e.message}`, 'error');
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        log(`API update failed: HTTP ${xhr.status} - ${xhr.responseText}`, 'error');
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => {
                    log('Network error during reminder update', 'error');
                    reject(new Error('Network error'));
                };
                
                xhr.send(JSON.stringify(payload));
            });

            if (response?.Entities && response.Entities.length > 0) {
                const updated = response.Entities[0];
                log(`Updated successfully: ${updated.ServiceReminderNumber}`, 'success');
                return updated;
            }
            
            log('Unexpected update response format', 'warning');
            return null;
        } catch (error) {
            log(`Update error: ${error.message}`, 'error');
            scriptHealthy = false;
            throw error;
        }
    }

    /**
     * Delete an existing service reminder
     * @param {object} existingReminder - The existing reminder object to delete
     * @returns {Promise<boolean>} - True if deleted successfully
     */
    async function deleteServiceReminder(existingReminder) {
        try {
            log('Deleting reminder...', 'info');
            
            // Get fresh token from localStorage
            antiForgeryToken = getAntiForgeryToken();
            if (!antiForgeryToken) {
                log('Cannot delete reminder: No anti-forgery token available', 'error');
                scriptHealthy = false;
                throw new Error('No anti-forgery token');
            }
            
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

            log(`API Call: Deleting reminder ${existingReminder.ServiceReminderNumber}`, 'debug');

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/SaveChanges/SaveChanges`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            log(`Failed to parse delete response: ${e.message}`, 'error');
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        log(`API delete failed: HTTP ${xhr.status} - ${xhr.responseText}`, 'error');
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => {
                    log('Network error during reminder deletion', 'error');
                    reject(new Error('Network error'));
                };
                
                xhr.send(JSON.stringify(payload));
            });

            log(`Deleted successfully: ${existingReminder.ServiceReminderNumber}`, 'success');
            return true;
        } catch (error) {
            log(`Delete error: ${error.message}`, 'error');
            scriptHealthy = false;
            throw error;
        }
    }

    // ==================== API MONITORING ====================

    /**
     * Monitor URL changes (Tradify is a single-page app)
     */
    function startUrlMonitoring() {
        log('Starting URL monitoring for hash changes', 'debug');
        
        // Monitor hash changes (Tradify uses hash routing)
        let lastJobId = getJobIdFromUrl();
        
        window.addEventListener('hashchange', () => {
            const newJobId = getJobIdFromUrl();
            log(`URL changed, job ID: ${newJobId || 'none'}`, 'debug');
            
            if (newJobId && newJobId !== lastJobId) {
                log(`Navigated to new job page: ${newJobId}`, 'info');
                // Show generic button immediately, will update when GetJobDetailData fires
                showGenericButtonForJobPage();
            } else if (!newJobId && lastJobId) {
                log('Navigated away from job page', 'debug');
                hideReminderButton();
            }
            
            lastJobId = newJobId;
        });
        
        // Also check current page on startup
        if (lastJobId) {
            log(`Already on job page on startup: ${lastJobId}`, 'info');
            // Show generic button immediately
            showGenericButtonForJobPage();
        }
    }

    /**
     * Monitor API calls to extract job data and detect saves
     */
    function startApiMonitoring() {

        // Intercept XMLHttpRequest (Tradify uses XHR for API calls)
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;
        
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._url = url;
            this._method = method;
            return originalXHROpen.apply(this, [method, url, ...rest]);
        };
        
        XMLHttpRequest.prototype.send = function(body) {
            const url = this._url;
            
            // Capture job data when page loads
            if (url && url.includes('/Job/GetJobDetailData')) {
                log('Intercepted GetJobDetailData API call', 'debug');
                this.addEventListener('load', async function() {
                    try {
                        const data = JSON.parse(this.responseText);
                        if (data?.ChildData?.JobStaffMembers?.[0]?.Job) {
                            currentJobData = data.ChildData.JobStaffMembers[0].Job;
                            const jobNumber = currentJobData.JobNumber;
                            const jobId = currentJobData.Id;
                            
                            log(`Job loaded via API: ${jobNumber} (ID: ${jobId})`, 'info');
                            
                            // Get token from localStorage
                            antiForgeryToken = getAntiForgeryToken();
                            if (!antiForgeryToken) {
                                log('⚠️ WARNING: No token found in localStorage. Script may not work.', 'warning');
                                scriptHealthy = false;
                                // Still show button but linking to service reminders page
                                showStatusButton(null, jobNumber);
                                return;
                            }
                            
                            log('Token retrieved from localStorage successfully', 'debug');
                            scriptHealthy = true;
                            
                            // Search for existing reminder and show status button
                            const existingReminder = await findServiceReminderByJob(jobId);
                            showStatusButton(existingReminder, jobNumber);
                        }
                    } catch (e) {
                        log(`Error parsing job data: ${e.message}`, 'error');
                        scriptHealthy = false;
                    }
                });
            }
            
            // Detect Service Due Date changes when job is saved
            if (url && url.includes('/SaveChanges/SaveChanges') && body) {
                try {
                    const requestData = JSON.parse(body);
                    const entity = requestData?.entities?.[0];
                    
                    if (entity?.entityAspect?.entityTypeName === 'Job:#Tradify.Models' && 'Custom4' in entity) {
                        const serviceDueDate = entity.Custom4;
                        const jobNumber = getJobNumber();
                        const jobId = getJobId();
                        
                        log(`Service Due Date ${serviceDueDate ? 'updated' : 'cleared'} for job ${jobNumber}`, 'info');
                        
                        // After save completes, search for existing reminder and decide action
                        this.addEventListener('load', async function() {
                            try {
                                const existingReminder = await findServiceReminderByJob(jobId);
                                
                                // Process immediately - no delay needed since we get token from localStorage
                                try {
                                    if (serviceDueDate && serviceDueDate.trim() !== '') {
                                        // Validate the date before creating/updating
                                        const validation = validateServiceDate(serviceDueDate);
                                        
                                        if (!validation.isValid) {
                                            log(`Invalid date: ${serviceDueDate} - ${validation.error}`, 'warning');
                                            // Show error notification for invalid date
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
                                                const deleted = await deleteServiceReminder(existingReminder);
                                                if (deleted) {
                                                    showNotification(
                                                        `🗑️ Existing Reminder Deleted<br><br>` +
                                                        `<strong>Job:</strong> ${jobNumber}<br>` +
                                                        `<strong>Number:</strong> ${existingReminder.ServiceReminderNumber}<br><br>` +
                                                        `<em>Date was ${validation.isPast ? 'in the past' : 'invalid'}</em>`,
                                                        'info'
                                                    );
                                                    // Update to show no reminder status
                                                    showStatusButton(null, jobNumber);
                                                }
                                            }
                                            return;
                                        }
                                        
                                        if (existingReminder) {
                                            // Update existing reminder
                                            const updated = await updateServiceReminder(existingReminder, serviceDueDate);
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
                                                // Update the status button
                                                showStatusButton(updated, jobNumber);
                                            }
                                        } else {
                                            // Create new reminder
                                            const created = await createServiceReminder(serviceDueDate);
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
                                                // Show the status button with reminder
                                                showStatusButton(created, jobNumber);
                                            }
                                        }
                                    } else {
                                        if (existingReminder) {
                                            // Delete existing reminder
                                            const deleted = await deleteServiceReminder(existingReminder);
                                            if (deleted) {
                                                showNotification(
                                                    `✅ Service Reminder Deleted<br><br>` +
                                                    `<strong>Job:</strong> ${jobNumber}<br>` +
                                                    `<strong>Number:</strong> ${existingReminder.ServiceReminderNumber}`,
                                                    'success'
                                                );
                                                // Update to show no reminder status
                                                showStatusButton(null, jobNumber);
                                            }
                                        } else {
                                            // No action needed
                                            log('Service Due Date cleared, no reminder to delete', 'info');
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
                                    scriptHealthy = false;
                                    showNotification(
                                        `❌ Failed to sync reminder<br><br>` +
                                        `<strong>Job:</strong> ${jobNumber}<br>` +
                                        `<strong>Error:</strong> ${error.message}<br><br>` +
                                        `Check console for details`,
                                        'error'
                                    );
                                }
                            } catch (error) {
                                log(`Search error: ${error.message}`, 'error');
                                scriptHealthy = false;
                                showNotification(
                                    `❌ Error searching for reminder<br><br>Check console for details`,
                                    'error'
                                );
                            }
                        });
                    }
                } catch (e) {
                    log(`Error parsing save request: ${e.message}`, 'error');
                }
            }
            
            return originalXHRSend.apply(this, arguments);
        };
    }

    // ==================== INITIALIZATION ====================

    function init() {
        log('========================================', 'info');
        log('Service Reminder Auto-Sync v1.4.0', 'info');
        log('========================================', 'info');
        
        // Check if we can access localStorage
        try {
            const testToken = getAntiForgeryToken();
            if (testToken) {
                log('✓ Token available in localStorage', 'success');
                scriptHealthy = true;
            } else {
                log('⚠ Token not yet available (will retry on job load)', 'warning');
            }
        } catch (error) {
            log(`✗ Error accessing localStorage: ${error.message}`, 'error');
            scriptHealthy = false;
        }
        
        // Check current URL
        const currentJobId = getJobIdFromUrl();
        if (currentJobId) {
            log(`On job page: ${currentJobId}`, 'info');
        } else {
            log('Not on a job page', 'debug');
        }
        
        startApiMonitoring();
        startUrlMonitoring();
        log('Monitoring active - ready to sync service reminders', 'success');
        log('========================================', 'info');
    }

    // Wait for DOM to be ready before initializing
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
