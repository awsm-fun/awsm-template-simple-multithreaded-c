// check.h — a minimal test harness: no framework needed for a project this size.
//
//   CHECK(cond)            records a failure (with file:line) and carries on
//   CHECK_NEAR(a, b, tol)  the same for floats, printing both values
//   return check_report(); at the end of main()

#ifndef CHECK_H
#define CHECK_H

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static int check_failures = 0;

#define CHECK(cond)                                                                                \
    do {                                                                                           \
        if (!(cond)) {                                                                             \
            fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond);               \
            check_failures++;                                                                      \
        }                                                                                          \
    } while (0)

#define CHECK_NEAR(a, b, tol)                                                                      \
    do {                                                                                           \
        double check_a_ = (double)(a);                                                             \
        double check_b_ = (double)(b);                                                             \
        if (!(fabs(check_a_ - check_b_) <= (double)(tol))) {                                       \
            fprintf(stderr, "%s:%d: CHECK_NEAR failed: %s = %g, %s = %g\n", __FILE__, __LINE__,    \
                    #a, check_a_, #b, check_b_);                                                   \
            check_failures++;                                                                      \
        }                                                                                          \
    } while (0)

static inline int check_report(void) {
    if (check_failures != 0) {
        fprintf(stderr, "%d check(s) failed\n", check_failures);
        return EXIT_FAILURE;
    }
    puts("all tests passed");
    return EXIT_SUCCESS;
}

#endif // CHECK_H
