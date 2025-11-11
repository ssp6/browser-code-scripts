// ==UserScript==
// @name         Tradify Service Reminder Auto-Sync
// @namespace    https://github.com/ssp6/browser-code-scripts
// @version      1.1.1
// @description  Automatically create, update, and delete service reminders when Service Due Date is updated on jobs
// @author       MPH Data
// @match        https://go.tradifyhq.com/*
// @grant        none
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/ssp6/browser-code-scripts/main/tradify-service-reminder-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/ssp6/browser-code-scripts/main/tradify-service-reminder-sync.user.js
// ==/UserScript==

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
    let antiForgeryToken = null;  // Capture from actual API calls

    // ==================== UTILITY FUNCTIONS ====================

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
     * Get service reminder URL
     */
    function getServiceReminderUrl(reminderId) {
        return `https://go.tradifyhq.com/#/servicereminder/${reminderId}`;
    }

    // ==================== UI NOTIFICATIONS ====================

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
            console.log('[ServiceReminder] Searching for existing reminder...');
            
            const jobNumber = getJobNumber();
            const payload = {
                searchQuery: jobNumber || '',
                sort: { expression: 'dueDate', isAscending: true },
                page: { pageIndex: 1, pageSize: 100 },
                selectedIds: [],
                dateFrom: null,
                dateTo: null,
                serviceReminderListFilter: 1
            };

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/ServiceReminder/GetServiceReminderList`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                
                if (antiForgeryToken) {
                    xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                } else {
                    console.warn('[ServiceReminder] No anti-forgery token available');
                }
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        console.error('[ServiceReminder] Search failed:', xhr.status, xhr.responseText);
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => reject(new Error('Network error'));
                xhr.send(JSON.stringify(payload));
            });

            if (response?.Data && Array.isArray(response.Data)) {
                const reminder = response.Data.find(r => r.SourceJobId === jobId);
                
                if (reminder) {
                    console.log(`[ServiceReminder] Found existing reminder: ${reminder.ServiceReminderNumber}`);
                    return reminder;
                } else {
                    console.log('[ServiceReminder] No existing reminder found');
                    return null;
                }
            }
            
            return null;
        } catch (error) {
            console.error('[ServiceReminder] Search error:', error);
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
            console.log('[ServiceReminder] Creating new reminder...');
            
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

            console.log('[ServiceReminder] Create payload:', JSON.stringify(payload));

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/SaveChanges/SaveChanges`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                
                if (antiForgeryToken) {
                    xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                }
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        console.error('[ServiceReminder] Create failed:', xhr.status, xhr.responseText);
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => reject(new Error('Network error'));
                xhr.send(JSON.stringify(payload));
            });

            if (response?.Entities && response.Entities.length > 0) {
                const created = response.Entities[0];
                console.log('[ServiceReminder] Created successfully:', created.ServiceReminderNumber);
                return created;
            }
            
            return null;
        } catch (error) {
            console.error('[ServiceReminder] Create error:', error);
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
            console.log('[ServiceReminder] Updating existing reminder...');
            
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

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/SaveChanges/SaveChanges`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                
                if (antiForgeryToken) {
                    xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                }
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch (e) {
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        console.error('[ServiceReminder] Update failed:', xhr.status, xhr.responseText);
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => reject(new Error('Network error'));
                xhr.send(JSON.stringify(payload));
            });

            if (response?.Entities && response.Entities.length > 0) {
                const updated = response.Entities[0];
                console.log('[ServiceReminder] Updated successfully:', updated.ServiceReminderNumber);
                return updated;
            }
            
            return null;
        } catch (error) {
            console.error('[ServiceReminder] Update error:', error);
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
            console.log('[ServiceReminder] Deleting reminder...');
            
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

            const response = await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${BASE_URL}/SaveChanges/SaveChanges`);
                
                xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
                xhr.setRequestHeader('accept', 'application/json, text/plain, */*');
                xhr.setRequestHeader('clientapiversion', '69');
                
                if (antiForgeryToken) {
                    xhr.setRequestHeader('requestverificationantiforgerytoken', antiForgeryToken);
                }
                
                xhr.onload = function() {
                    if (xhr.status === 200) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
            } catch (e) {
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        console.error('[ServiceReminder] Delete failed:', xhr.status, xhr.responseText);
                        reject(new Error(`HTTP ${xhr.status}`));
                    }
                };
                
                xhr.onerror = () => reject(new Error('Network error'));
                xhr.send(JSON.stringify(payload));
            });

            console.log('[ServiceReminder] Deleted successfully:', existingReminder.ServiceReminderNumber);
            return true;
        } catch (error) {
            console.error('[ServiceReminder] Delete error:', error);
            throw error;
        }
    }

    // ==================== API MONITORING ====================

    /**
     * Monitor API calls to extract job data and detect saves
     */
    function startApiMonitoring() {

        // Intercept XMLHttpRequest (Tradify uses XHR for API calls)
        const originalXHROpen = XMLHttpRequest.prototype.open;
        const originalXHRSend = XMLHttpRequest.prototype.send;
        
        // Store original setRequestHeader to capture headers
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this._url = url;
            this._method = method;
            this._headers = {};
            return originalXHROpen.apply(this, [method, url, ...rest]);
        };
        
        XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
            // Capture the anti-forgery token when we see it
            if (header.toLowerCase() === 'requestverificationantiforgerytoken' && !antiForgeryToken) {
                antiForgeryToken = value;
                console.log('[ServiceReminder] Token captured');
            }
            this._headers[header] = value;
            return originalSetRequestHeader.apply(this, [header, value]);
        };
        
        XMLHttpRequest.prototype.send = function(body) {
            const url = this._url;
            
            // Capture job data when page loads
            if (url && url.includes('/Job/GetJobDetailData')) {
                this.addEventListener('load', function() {
                    try {
                        const data = JSON.parse(this.responseText);
                        if (data?.ChildData?.JobStaffMembers?.[0]?.Job) {
                            currentJobData = data.ChildData.JobStaffMembers[0].Job;
                            console.log('[ServiceReminder] Job loaded:', currentJobData.JobNumber);
                        }
                    } catch (e) {
                        console.error('[ServiceReminder] Error parsing job data:', e);
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
                        
                        console.log(`[ServiceReminder] Service Due Date ${serviceDueDate ? 'updated' : 'cleared'} (${jobNumber})`);
                        
                        // After save completes, search for existing reminder and decide action
                        this.addEventListener('load', async function() {
                            try {
                                const existingReminder = await findServiceReminderByJob(jobId);
                                
                                // Small delay to ensure page state is updated
                                setTimeout(async () => {
                                    try {
                                        if (serviceDueDate && serviceDueDate.trim() !== '') {
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
                                                }
                                            } else {
                                                // No action needed
                                                showNotification(
                                                    `ℹ️ Service Due Date Cleared<br><br>` +
                                                    `<strong>Job:</strong> ${jobNumber}<br><br>` +
                                                    `<em>No reminder to delete</em>`,
                                                    'info'
                                                );
                                            }
                                        }
                                    } catch (error) {
                                        console.error('[ServiceReminder] Operation error:', error);
                                        showNotification(
                                            `❌ Failed to sync reminder<br><br>` +
                                            `<strong>Job:</strong> ${jobNumber}<br>` +
                                            `<strong>Error:</strong> ${error.message}<br><br>` +
                                            `Check console for details`,
                                            'error'
                                        );
                                    }
                                }, 500);
                            } catch (error) {
                                console.error('[ServiceReminder] Search error:', error);
                                showNotification(
                                    `❌ Error searching for reminder<br><br>Check console for details`,
                                    'error'
                                );
                            }
                        });
                    }
                } catch (e) {
                    console.error('[ServiceReminder] Error parsing save request:', e);
                }
            }
            
            return originalXHRSend.apply(this, arguments);
        };
    }

    // ==================== INITIALIZATION ====================

    function init() {
        startApiMonitoring();
        console.log('[ServiceReminder] Monitoring active');
    }

        init();
})();
