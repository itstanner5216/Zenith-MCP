package polaris

import (
	"fmt"
	strutil "strings"
)

func GoCompute(n int) int {
	return goHelper(n) + goHelper(n)
}

func goHelper(n int) int {
	fmt.Println(strutil.ToUpper("x"))
	return n
}
