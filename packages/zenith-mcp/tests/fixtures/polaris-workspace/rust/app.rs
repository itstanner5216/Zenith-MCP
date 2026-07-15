use std::collections::HashMap;
use std::fmt as rsfmt;

pub fn rs_compute(n: i32) -> i32 {
    rs_helper(n) + rs_helper(n)
}

fn rs_helper(n: i32) -> i32 {
    let mut m: HashMap<i32, i32> = HashMap::new();
    m.insert(n, n);
    n * 2
}
