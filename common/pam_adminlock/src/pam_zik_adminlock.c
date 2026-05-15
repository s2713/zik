/*
 * pam_zik_adminlock.c — PAM module enforcing the admin device lock.
 *
 * Reads /var/lib/zik/adminlock (written by zik-privhelp admin-lock --set):
 *   absent        → device unlocked, PAM_SUCCESS for all users
 *   empty file    → device locked indefinitely
 *   "<timestamp>" → device locked until that Unix timestamp (double)
 *
 * The admin user (ADMIN_USER) is always allowed through, so SSH and VT
 * logins for the admin account work regardless of lock state.
 */

#include <security/pam_appl.h>
#include <security/pam_ext.h>
#include <security/pam_modules.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define LOCK_FILE  "/var/lib/zik/adminlock"
#define ADMIN_USER "zik-admin"

PAM_EXTERN int
pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc, const char **argv)
{
    (void)flags; (void)argc; (void)argv;

    /* Get the PAM username. */
    const char *user = NULL;
    if (pam_get_user(pamh, &user, NULL) != PAM_SUCCESS || user == NULL)
        return PAM_AUTH_ERR;

    /* Admin user always gets through regardless of lock state. */
    if (strcmp(user, ADMIN_USER) == 0)
        return PAM_SUCCESS;

    /* Check whether the lock file is present. */
    FILE *f = fopen(LOCK_FILE, "r");
    if (f == NULL)
        return PAM_SUCCESS;  /* no lock file → unlocked */

    /* Read content: empty = indefinite lock, numeric string = expiry timestamp. */
    char buf[64] = {0};
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);

    /* Trim trailing whitespace. */
    while (n > 0 &&
           (buf[n - 1] == '\n' || buf[n - 1] == '\r' || buf[n - 1] == ' '))
        buf[--n] = '\0';

    if (n > 0) {
        /* Parse as Unix timestamp and check if the lock has expired. */
        char *endp = NULL;
        double until = strtod(buf, &endp);
        if (endp != buf && (double)time(NULL) >= until)
            return PAM_SUCCESS;  /* lock expired */
    }

    /* Device is locked — inform the user and deny access. */
    pam_info(pamh, "Device is locked by the administrator.");
    return PAM_AUTH_ERR;
}

PAM_EXTERN int
pam_sm_setcred(pam_handle_t *pamh, int flags, int argc, const char **argv)
{
    (void)pamh; (void)flags; (void)argc; (void)argv;
    return PAM_SUCCESS;
}
