context("datasets")

datashapetests = function(df, ncols, nrows, uniquecol = NULL, nuniques = NULL) {
  testthat::expect_equal(ncol(df), ncols)
  testthat::expect_equal(nrow(df), nrows)
  if (!is.null(uniquecol)) {
    testthat::expect_equal(nrow(unique(df[uniquecol])), nuniques)
  }
}

test_that("datasaurus_dozen is correctly shaped", {
  datashapetests(datasaurus_dozen, 3, 1846, "dataset", 13)
})
